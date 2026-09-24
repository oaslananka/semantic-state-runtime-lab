import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import {
  canonicalJson,
  valuesEqual,
  type EntityId,
  type ExternalBinding,
  type ExternalSnapshot,
  type Mutation,
  type StateValue,
} from "@ssrl/core";
import {
  validateConnectorManifest,
  type ConnectorFieldMapping,
  type ConnectorManifest,
  type ManifestedStateProvider,
} from "@ssrl/connector-sdk";
import {
  sourceCheckpoint,
  sourceContinuation,
  type ArtifactProjectionDraft,
  type ArtifactProjectionMapper,
  type DesiredProjection,
  type IncrementalSource,
  type ProjectionMapper,
  type SourceChange,
  type SourceChangeDraft,
  type SourceContinuation,
  type SourceReadRequest,
  type SourceReadResult,
} from "@ssrl/ingestion";
import { isMap, parseDocument } from "yaml";

type ParsedDocument = ReturnType<typeof parseDocument>;
type LineEnding = "\n" | "\r\n";
type OptionalLineEnding = "" | LineEnding;
type FrontmatterDelimiter = "---" | "...";

interface MarkdownParts {
  readonly bom: string;
  readonly document: ParsedDocument;
  readonly body: string;
  readonly eol: LineEnding;
  readonly closingMarker: FrontmatterDelimiter;
  readonly closingEol: OptionalLineEnding;
}

export interface MarkdownFilesystemConnectorOptions {
  readonly root: string;
  readonly manifest: ConnectorManifest;
  readonly now?: () => string;
}

export class UnsafeMarkdownPathError extends Error {
  constructor(readonly externalId: string, message: string) {
    super(`Unsafe Markdown externalId "${externalId}": ${message}`);
    this.name = "UnsafeMarkdownPathError";
  }
}

export class InvalidMarkdownFrontmatterError extends Error {
  constructor(readonly externalId: string, message: string) {
    super(`Invalid Markdown frontmatter for "${externalId}": ${message}`);
    this.name = "InvalidMarkdownFrontmatterError";
  }
}

export class StaleMarkdownFileError extends Error {
  constructor(
    readonly expectedRevision: string | undefined,
    readonly actualRevision: string,
  ) {
    super(
      `Markdown file changed: expected ${expectedRevision ?? "a base revision"}, actual ${actualRevision}`,
    );
    this.name = "StaleMarkdownFileError";
  }
}

function revisionFor(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function stripLineEnding(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n")) return line.slice(0, -1);
  return line;
}

function lineEnding(line: string): OptionalLineEnding {
  if (line.endsWith("\r\n")) return "\r\n";
  if (line.endsWith("\n")) return "\n";
  return "";
}

function assertMappingDocument(
  externalId: string,
  document: ParsedDocument,
): ParsedDocument {
  if (document.errors.length > 0) {
    throw new InvalidMarkdownFrontmatterError(
      externalId,
      document.errors.map((error) => error.message).join("; "),
    );
  }
  if (document.contents === null) {
    document.contents = document.createNode({});
  } else if (!isMap(document.contents)) {
    throw new InvalidMarkdownFrontmatterError(
      externalId,
      "frontmatter root must be a mapping",
    );
  }
  return document;
}

function preferredLineEnding(source: string): LineEnding {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function frontmatterlessParts(
  externalId: string,
  bom: string,
  source: string,
  eol: LineEnding,
): MarkdownParts {
  return {
    bom,
    document: assertMappingDocument(externalId, parseDocument("")),
    body: source,
    eol,
    closingMarker: "---",
    closingEol: eol,
  };
}

interface ClosingDelimiter {
  readonly index: number;
  readonly lineEnd: number;
  readonly marker: FrontmatterDelimiter;
  readonly eol: OptionalLineEnding;
}

function findClosingDelimiter(source: string, start: number): ClosingDelimiter | undefined {
  let cursor = start;
  while (cursor <= source.length) {
    const nextNewline = source.indexOf("\n", cursor);
    const lineEnd = nextNewline < 0 ? source.length : nextNewline + 1;
    const rawLine = source.slice(cursor, lineEnd);
    const marker = stripLineEnding(rawLine).trimEnd();

    if (marker === "---" || marker === "...") {
      return { index: cursor, lineEnd, marker, eol: lineEnding(rawLine) };
    }
    if (nextNewline < 0) return undefined;
    cursor = nextNewline + 1;
  }
  return undefined;
}

function splitMarkdown(externalId: string, content: string): MarkdownParts {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = content.slice(bom.length);
  const firstNewline = source.indexOf("\n");

  if (firstNewline < 0) {
    if (source.trimEnd() === "---") {
      throw new InvalidMarkdownFrontmatterError(externalId, "opening delimiter has no closing delimiter");
    }
    return frontmatterlessParts(externalId, bom, source, "\n");
  }

  const firstLine = source.slice(0, firstNewline + 1);
  if (stripLineEnding(firstLine).trimEnd() !== "---") {
    return frontmatterlessParts(externalId, bom, source, preferredLineEnding(source));
  }

  const eol = lineEnding(firstLine) === "\r\n" ? "\r\n" : "\n";
  const closing = findClosingDelimiter(source, firstNewline + 1);
  if (closing === undefined) {
    throw new InvalidMarkdownFrontmatterError(externalId, "opening delimiter has no closing delimiter");
  }

  const frontmatter = source.slice(firstNewline + 1, closing.index);
  return {
    bom,
    document: assertMappingDocument(externalId, parseDocument(frontmatter)),
    body: source.slice(closing.lineEnd),
    eol,
    closingMarker: closing.marker,
    closingEol: closing.eol,
  };
}

function stringifyMarkdown(parts: MarkdownParts): string {
  const yaml = parts.document
    .toString({ lineWidth: 0 })
    .replace(/\n$/, "")
    .replaceAll("\n", parts.eol);

  return [
    parts.bom,
    "---",
    parts.eol,
    yaml,
    parts.eol,
    parts.closingMarker,
    parts.closingEol,
    parts.body,
  ].join("");
}

function externalPathSegments(path: string): string[] {
  if (path.length === 0) throw new Error("External frontmatter path must not be empty");
  if (!path.startsWith("/")) return [path];

  return path
    .slice(1)
    .split("/")
    .map((segment) => {
      if (/~(?:[^01]|$)/.test(segment)) {
        throw new Error(`Invalid JSON Pointer escape in external path: ${path}`);
      }
      return segment.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (
      current === null
      || typeof current !== "object"
      || Array.isArray(current)
      || !(segment in current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toStateValue(value: unknown): StateValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Frontmatter contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => {
      const converted = toStateValue(child);
      if (converted === undefined) throw new Error("Frontmatter arrays cannot contain undefined");
      return converted;
    });
  }
  if (typeof value === "object") {
    const converted: Record<string, StateValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const stateValue = toStateValue(child);
      if (stateValue !== undefined) converted[key] = stateValue;
    }
    return converted;
  }
  throw new Error(`Unsupported frontmatter value type: ${typeof value}`);
}

function externalIdSegments(externalId: string): string[] {
  if (externalId.length === 0) {
    throw new UnsafeMarkdownPathError(externalId, "path must not be empty");
  }
  if (externalId.includes("\0")) {
    throw new UnsafeMarkdownPathError(externalId, "NUL bytes are not allowed");
  }
  if (externalId.includes("\\")) {
    throw new UnsafeMarkdownPathError(externalId, "use forward slashes for portable relative paths");
  }
  if (isAbsolute(externalId) || posix.isAbsolute(externalId) || win32.isAbsolute(externalId)) {
    throw new UnsafeMarkdownPathError(externalId, "absolute paths are not allowed");
  }

  const segments = externalId.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new UnsafeMarkdownPathError(externalId, "empty, dot, and parent segments are not allowed");
  }
  if (!segments.at(-1)?.toLowerCase().endsWith(".md")) {
    throw new UnsafeMarkdownPathError(externalId, "only .md files are supported");
  }
  return segments;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

export class MarkdownFilesystemConnector implements ManifestedStateProvider {
  readonly id: string;
  readonly manifest: ConnectorManifest;
  readonly #root: string;
  readonly #now: () => string;

  constructor(options: MarkdownFilesystemConnectorOptions) {
    validateConnectorManifest(options.manifest);
    this.id = options.manifest.id;
    this.manifest = options.manifest;
    this.#root = resolve(options.root);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #declaredMapping(canonical: string, external: string): ConnectorFieldMapping | undefined {
    for (const entity of this.manifest.entities) {
      const mapping = entity.fields.find(
        (field) => field.canonical === canonical && field.external === external,
      );
      if (mapping !== undefined) return mapping;
    }
    return undefined;
  }

  #assertBinding(binding: ExternalBinding): void {
    if (binding.provider !== this.id) {
      throw new Error(`Binding provider ${binding.provider} does not match ${this.id}`);
    }

    for (const field of binding.fields) {
      const declared = this.#declaredMapping(field.canonical, field.external);
      if (declared === undefined) {
        throw new Error(
          `Binding field ${field.canonical} -> ${field.external} is not declared by connector manifest`,
        );
      }
      if (field.readable && !declared.access.includes("read")) {
        throw new Error(`Binding field ${field.canonical} is not declared readable`);
      }
      if (field.writable && !declared.access.includes("write")) {
        throw new Error(`Binding field ${field.canonical} is not declared writable`);
      }
    }
  }

  #assertMutation(mutation: Mutation): void {
    if (mutation.provider !== this.id) {
      throw new Error(`Mutation provider ${mutation.provider} does not match ${this.id}`);
    }
    const declared = this.#declaredMapping(mutation.canonicalProperty, mutation.externalPath);
    if (declared === undefined || !declared.access.includes("write")) {
      throw new Error(
        `Mutation field ${mutation.canonicalProperty} -> ${mutation.externalPath} is not declared writable`,
      );
    }
  }

  async #secureFile(externalId: string): Promise<string> {
    const segments = externalIdSegments(externalId);
    const root = await realpath(this.#root);
    const requested = resolve(root, ...segments);

    if (!isWithinRoot(root, requested)) {
      throw new UnsafeMarkdownPathError(externalId, "resolved path escapes connector root");
    }

    const file = await realpath(requested);
    if (!isWithinRoot(root, file)) {
      throw new UnsafeMarkdownPathError(externalId, "symbolic link escapes connector root");
    }

    const info = await stat(file);
    if (!info.isFile()) {
      throw new UnsafeMarkdownPathError(externalId, "resolved path is not a regular file");
    }
    return file;
  }

  async observe(binding: ExternalBinding): Promise<ExternalSnapshot> {
    this.#assertBinding(binding);
    const file = await this.#secureFile(binding.externalId);
    const content = await readFile(file, "utf8");
    const parts = splitMarkdown(binding.externalId, content);
    const frontmatter = parts.document.toJSON() as unknown;
    const values: Record<string, StateValue | undefined> = {};

    for (const field of binding.fields) {
      if (!field.readable) continue;
      values[field.external] = toStateValue(
        valueAtPath(frontmatter, externalPathSegments(field.external)),
      );
    }

    return {
      binding,
      revision: revisionFor(content),
      observedAt: this.#now(),
      values,
    };
  }

  async apply(mutation: Mutation): Promise<void> {
    this.#assertMutation(mutation);
    const file = await this.#secureFile(mutation.externalId);
    const content = await readFile(file, "utf8");
    const actualRevision = revisionFor(content);

    if (mutation.baseRevision === undefined || mutation.baseRevision !== actualRevision) {
      throw new StaleMarkdownFileError(mutation.baseRevision, actualRevision);
    }

    const parts = splitMarkdown(mutation.externalId, content);
    const path = externalPathSegments(mutation.externalPath);
    const current = toStateValue(valueAtPath(parts.document.toJSON(), path));

    if (mutation.previousValue !== undefined && !valuesEqual(current, mutation.previousValue)) {
      throw new StaleMarkdownFileError(mutation.baseRevision, actualRevision);
    }

    parts.document.setIn(path, mutation.nextValue);
    const nextContent = stringifyMarkdown(parts);
    const temp = resolve(
      dirname(file),
      `.${basename(file)}.ssrl-${randomUUID()}.tmp`,
    );

    try {
      await writeFile(temp, nextContent, { encoding: "utf8", flush: true });

      // A second read catches edits that race with YAML serialization/temp-file writing.
      // There is still a very small cross-process race before rename; this connector
      // therefore does not claim linearizable compare-and-swap semantics.
      const latest = await readFile(file, "utf8");
      const latestRevision = revisionFor(latest);
      if (latestRevision !== actualRevision) {
        throw new StaleMarkdownFileError(mutation.baseRevision, latestRevision);
      }

      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }
}


export interface MarkdownIngestionPayload {
  readonly values: Readonly<Record<string, StateValue>>;
}

export interface MarkdownAuthoritativeIngestionOptions {
  readonly root: string;
  readonly manifest: ConnectorManifest;
  readonly externalType: string;
  readonly entityIdForExternalId: (externalId: string) => EntityId;
  readonly externalIds?: readonly string[];
  readonly rejectUnlistedExternalIds?: boolean;
  readonly pageSize?: number;
  readonly maxFiles?: number;
  readonly maxRawBytes?: number;
}

export class StaleMarkdownIngestionSourceError extends Error {
  constructor(
    readonly externalId: string,
    readonly expectedRevision: string,
    readonly actualRevision?: string,
  ) {
    super(
      `Markdown ingestion source ${externalId} changed after scan: expected ${expectedRevision}, actual ${actualRevision ?? "missing"}`,
    );
    this.name = "StaleMarkdownIngestionSourceError";
  }
}

export class InvalidMarkdownEncodingError extends Error {
  constructor(readonly externalId: string) {
    super(`Markdown ingestion source ${externalId} is not valid UTF-8`);
    this.name = "InvalidMarkdownEncodingError";
  }
}

export class MarkdownScanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownScanLimitError";
  }
}

export class InvalidMarkdownContinuationError extends Error {
  constructor(readonly continuation: string) {
    super(`Invalid or expired Markdown full-scan continuation: ${continuation}`);
    this.name = "InvalidMarkdownContinuationError";
  }
}


export class UnconfiguredMarkdownIngestionSourceError extends Error {
  constructor(readonly externalId: string) {
    super(`Markdown ingestion source ${externalId} is not in the configured authoritative inventory`);
    this.name = "UnconfiguredMarkdownIngestionSourceError";
  }
}

interface MarkdownScanEntry {
  readonly externalId: string;
  readonly revision: string;
  readonly payload: MarkdownIngestionPayload;
}

interface MarkdownScanSession {
  readonly id: string;
  readonly entries: readonly MarkdownScanEntry[];
  readonly checkpoint: ReturnType<typeof sourceCheckpoint>;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawRevision(bytes: Uint8Array): string {
  return `sha256:${sha256Bytes(bytes)}`;
}

function deterministicHashId(prefix: string, values: readonly unknown[]): string {
  const digest = createHash("sha256").update(canonicalJson(values), "utf8").digest("hex");
  return `${prefix}:${digest}`;
}

function decodeMarkdown(externalId: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidMarkdownEncodingError(externalId);
  }
}

function readableValues(
  externalId: string,
  content: string,
  fields: readonly ConnectorFieldMapping[],
): Readonly<Record<string, StateValue>> {
  const parts = splitMarkdown(externalId, content);
  const frontmatter = parts.document.toJSON() as unknown;
  const values: Record<string, StateValue> = {};
  for (const field of fields) {
    if (!field.access.includes("read")) continue;
    const value = toStateValue(valueAtPath(frontmatter, externalPathSegments(field.external)));
    if (value !== undefined) values[field.external] = value;
  }
  return values;
}

function portableExternalId(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

async function authoritativeMarkdownFiles(
  root: string,
  maxFiles: number,
  externalIds?: ReadonlySet<string>,
  rejectUnlistedExternalIds = false,
): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const externalId = portableExternalId(root, child);
        if (externalIds !== undefined && !externalIds.has(externalId)) {
          if (rejectUnlistedExternalIds) {
            throw new UnconfiguredMarkdownIngestionSourceError(externalId);
          }
          continue;
        }
        files.push(child);
        if (files.length > maxFiles) {
          throw new MarkdownScanLimitError(
            `Markdown scan found more than maxFiles ${maxFiles}`,
          );
        }
      }
    }
  }
  await walk(root);
  return files;
}

async function secureMarkdownBytes(
  root: string,
  externalId: string,
  maxBytes?: number,
): Promise<Uint8Array> {
  const segments = externalIdSegments(externalId);
  const realRoot = await realpath(root);
  const requested = resolve(realRoot, ...segments);
  if (!isWithinRoot(realRoot, requested)) {
    throw new UnsafeMarkdownPathError(externalId, "resolved path escapes connector root");
  }
  let info;
  try {
    info = await lstat(requested);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StaleMarkdownIngestionSourceError(externalId, "present-at-scan");
    }
    throw cause;
  }
  if (info.isSymbolicLink()) {
    throw new UnsafeMarkdownPathError(externalId, "symbolic links are not authoritative ingestion files");
  }
  if (!info.isFile()) {
    throw new UnsafeMarkdownPathError(externalId, "resolved path is not a regular file");
  }
  if (maxBytes !== undefined && info.size > maxBytes) {
    throw new MarkdownScanLimitError(
      `Markdown scan would exceed maxRawBytes while reading ${externalId}`,
    );
  }
  const file = await realpath(requested);
  if (!isWithinRoot(realRoot, file)) {
    throw new UnsafeMarkdownPathError(externalId, "resolved file escapes connector root");
  }
  const bytes = new Uint8Array(await readFile(file));
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    throw new MarkdownScanLimitError(
      `Markdown scan exceeded maxRawBytes while reading ${externalId}`,
    );
  }
  return bytes;
}

function matchingEntityMapping(
  manifest: ConnectorManifest,
  externalType: string,
): ConnectorManifest["entities"][number] {
  const matches = manifest.entities.filter((entity) => entity.externalType === externalType);
  if (matches.length !== 1) {
    throw new Error(
      `Markdown ingestion externalType ${externalType} must match exactly one manifest entity mapping`,
    );
  }
  return matches[0]!;
}

function continuationValue(sessionId: string, offset: number): SourceContinuation {
  return sourceContinuation(`markdown-full-v1:${sessionId}:${offset}`);
}

function parseContinuation(value: SourceContinuation): { readonly sessionId: string; readonly offset: number } {
  const match = /^markdown-full-v1:([0-9a-f-]+):(\d+)$/i.exec(value);
  if (match === null) throw new InvalidMarkdownContinuationError(value);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 1) throw new InvalidMarkdownContinuationError(value);
  return { sessionId: match[1]!, offset };
}

/**
 * Correctness-first Markdown ingestion adapter.
 * It intentionally performs an authoritative full scan on every sync round;
 * filesystem watch APIs may be added later only as wake-up/dirty hints.
 */
export class MarkdownAuthoritativeIngestionAdapter
implements
  IncrementalSource<MarkdownIngestionPayload>,
  ProjectionMapper<MarkdownIngestionPayload>,
  ArtifactProjectionMapper<MarkdownIngestionPayload> {
  readonly #root: string;
  readonly #manifest: ConnectorManifest;
  readonly #mapping: ConnectorManifest["entities"][number];
  readonly #entityIdForExternalId: (externalId: string) => EntityId;
  readonly #externalIds: ReadonlySet<string> | undefined;
  readonly #rejectUnlistedExternalIds: boolean;
  readonly #pageSize: number;
  readonly #maxFiles: number;
  readonly #maxRawBytes: number;
  readonly #sessions = new Map<string, MarkdownScanSession>();

  constructor(options: MarkdownAuthoritativeIngestionOptions) {
    validateConnectorManifest(options.manifest);
    this.#root = resolve(options.root);
    this.#manifest = options.manifest;
    this.#mapping = matchingEntityMapping(options.manifest, options.externalType);
    this.#entityIdForExternalId = options.entityIdForExternalId;
    if (options.externalIds === undefined) {
      this.#externalIds = undefined;
    } else {
      const normalized = options.externalIds.map((externalId) => {
        externalIdSegments(externalId);
        return externalId;
      });
      if (new Set(normalized).size !== normalized.length) {
        throw new TypeError("Markdown externalIds must be unique");
      }
      this.#externalIds = new Set(normalized);
    }
    this.#rejectUnlistedExternalIds = options.rejectUnlistedExternalIds ?? false;
    this.#pageSize = positiveSafeInteger(options.pageSize ?? 128, "Markdown pageSize");
    this.#maxFiles = positiveSafeInteger(options.maxFiles ?? 10_000, "Markdown maxFiles");
    this.#maxRawBytes = positiveSafeInteger(
      options.maxRawBytes ?? 256 * 1024 * 1024,
      "Markdown maxRawBytes",
    );
  }

  async #scan(): Promise<MarkdownScanSession> {
    const root = await realpath(this.#root);
    const files = await authoritativeMarkdownFiles(
      root,
      this.#maxFiles,
      this.#externalIds,
      this.#rejectUnlistedExternalIds,
    );

    const entries: MarkdownScanEntry[] = [];
    let rawBytes = 0;
    for (const file of files) {
      const externalId = portableExternalId(root, file);
      const bytes = await secureMarkdownBytes(
        root,
        externalId,
        this.#maxRawBytes - rawBytes,
      );
      rawBytes += bytes.byteLength;
      const revision = rawRevision(bytes);
      entries.push({
        externalId,
        revision,
        payload: {
          values: readableValues(
            externalId,
            decodeMarkdown(externalId, bytes),
            this.#mapping.fields,
          ),
        },
      });
    }
    const checkpoint = sourceCheckpoint(deterministicHashId(
      "markdown-inventory-v1",
      entries.map((entry) => [entry.externalId, entry.revision]),
    ));
    return { id: randomUUID(), entries, checkpoint };
  }

  #change(entry: MarkdownScanEntry): SourceChangeDraft<MarkdownIngestionPayload> {
    return {
      changeId: deterministicHashId(
        "markdown-change-v1",
        [this.#mapping.externalType, entry.externalId, entry.revision],
      ),
      externalType: this.#mapping.externalType,
      externalId: entry.externalId,
      kind: "upsert",
      revision: entry.revision,
      payload: entry.payload,
    };
  }

  #page(session: MarkdownScanSession, offset: number): SourceReadResult<MarkdownIngestionPayload> {
    if (offset < 0 || offset > session.entries.length) {
      throw new InvalidMarkdownContinuationError(continuationValue(session.id, offset));
    }
    const end = Math.min(offset + this.#pageSize, session.entries.length);
    const changes = session.entries.slice(offset, end).map((entry) => this.#change(entry));
    if (end < session.entries.length) {
      return {
        kind: "page",
        changes,
        next: { kind: "continue", cursor: continuationValue(session.id, end) },
      };
    }
    this.#sessions.delete(session.id);
    return { kind: "page", changes, next: { kind: "complete", checkpoint: session.checkpoint } };
  }

  async read(request: SourceReadRequest): Promise<SourceReadResult<MarkdownIngestionPayload>> {
    if (request.mode === "incremental") {
      return {
        kind: "reset-required",
        reason: "portable-markdown-filesystem-requires-authoritative-full-scan",
      };
    }
    if (request.continuation !== undefined) {
      const parsed = parseContinuation(request.continuation);
      const session = this.#sessions.get(parsed.sessionId);
      if (session === undefined) throw new InvalidMarkdownContinuationError(request.continuation);
      return this.#page(session, parsed.offset);
    }

    // A continuation belongs only to the immediately active full scan. Starting a
    // fresh authoritative scan expires abandoned sessions instead of retaining
    // unbounded directory snapshots in memory.
    this.#sessions.clear();
    const session = await this.#scan();
    if (session.entries.length > this.#pageSize) this.#sessions.set(session.id, session);
    return this.#page(session, 0);
  }

  project(change: SourceChange<MarkdownIngestionPayload>): DesiredProjection {
    if (change.kind !== "upsert" || change.payload === undefined || change.revision === undefined) {
      throw new Error("Markdown semantic projection requires an upsert payload and revision");
    }
    if (change.externalType !== this.#mapping.externalType) {
      throw new Error(`Unexpected Markdown external type ${change.externalType}`);
    }
    const entityId = this.#entityIdForExternalId(change.externalId);
    const slots: DesiredProjection["slots"][number][] = [];
    for (const field of this.#mapping.fields) {
      if (!field.access.includes("read")) continue;
      const value = change.payload.values[field.external];
      if (value === undefined) continue;
      slots.push({
        key: field.canonical,
        kind: "observation",
        record: {
          id: deterministicHashId(
            "markdown-observation-v1",
            [change.externalId, change.revision, field.canonical, field.external],
          ),
          entityId,
          property: field.canonical,
          value,
          source: {
            provider: this.#manifest.id,
            externalId: change.externalId,
            revision: change.revision,
          },
          validFrom: change.effectiveAt,
          recordedAt: change.recordedAt,
        },
      });
    }
    return {
      additiveEntities: [{ entityId, entityType: this.#mapping.canonicalType }],
      slots,
    };
  }

  async projectArtifact(
    change: SourceChange<MarkdownIngestionPayload>,
  ): Promise<ArtifactProjectionDraft | undefined> {
    if (change.kind !== "upsert") return undefined;
    if (change.revision === undefined) {
      throw new Error("Markdown artifact projection requires a content revision");
    }
    let bytes: Uint8Array;
    try {
      bytes = await secureMarkdownBytes(this.#root, change.externalId);
    } catch (cause) {
      if (cause instanceof StaleMarkdownIngestionSourceError) {
        throw new StaleMarkdownIngestionSourceError(change.externalId, change.revision);
      }
      throw cause;
    }
    const actualRevision = rawRevision(bytes);
    if (actualRevision !== change.revision) {
      throw new StaleMarkdownIngestionSourceError(
        change.externalId,
        change.revision,
        actualRevision,
      );
    }
    return {
      bytes,
      mediaType: "text/markdown",
      title: basename(change.externalId),
    };
  }
}
