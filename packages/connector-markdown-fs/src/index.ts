import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
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
  valuesEqual,
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
import { isMap, parseDocument } from "yaml";

type ParsedDocument = ReturnType<typeof parseDocument>;

interface MarkdownParts {
  readonly bom: string;
  readonly document: ParsedDocument;
  readonly body: string;
  readonly eol: "\n" | "\r\n";
  readonly closingMarker: "---" | "...";
  readonly closingEol: "" | "\n" | "\r\n";
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

function lineEnding(line: string): "" | "\n" | "\r\n" {
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

function splitMarkdown(externalId: string, content: string): MarkdownParts {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = content.slice(bom.length);
  const firstNewline = source.indexOf("\n");

  if (firstNewline < 0) {
    if (source.trimEnd() === "---") {
      throw new InvalidMarkdownFrontmatterError(externalId, "opening delimiter has no closing delimiter");
    }
    return {
      bom,
      document: assertMappingDocument(externalId, parseDocument("")),
      body: source,
      eol: "\n",
      closingMarker: "---",
      closingEol: "\n",
    };
  }

  const firstLine = source.slice(0, firstNewline + 1);
  if (stripLineEnding(firstLine).trimEnd() !== "---") {
    return {
      bom,
      document: assertMappingDocument(externalId, parseDocument("")),
      body: source,
      eol: source.includes("\r\n") ? "\r\n" : "\n",
      closingMarker: "---",
      closingEol: source.includes("\r\n") ? "\r\n" : "\n",
    };
  }

  const eol = lineEnding(firstLine) === "\r\n" ? "\r\n" : "\n";
  let cursor = firstNewline + 1;

  while (cursor <= source.length) {
    const nextNewline = source.indexOf("\n", cursor);
    const lineEnd = nextNewline < 0 ? source.length : nextNewline + 1;
    const rawLine = source.slice(cursor, lineEnd);
    const marker = stripLineEnding(rawLine).trimEnd();

    if (marker === "---" || marker === "...") {
      const frontmatter = source.slice(firstNewline + 1, cursor);
      return {
        bom,
        document: assertMappingDocument(externalId, parseDocument(frontmatter)),
        body: source.slice(lineEnd),
        eol,
        closingMarker: marker,
        closingEol: lineEnding(rawLine),
      };
    }

    if (nextNewline < 0) break;
    cursor = nextNewline + 1;
  }

  throw new InvalidMarkdownFrontmatterError(externalId, "opening delimiter has no closing delimiter");
}

function stringifyMarkdown(parts: MarkdownParts): string {
  const yaml = parts.document
    .toString({ lineWidth: 0 })
    .replace(/\n$/, "")
    .replace(/\n/g, parts.eol);

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
      return segment.replace(/~1/g, "/").replace(/~0/g, "~");
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
      throw new Error("Frontmatter contains a non-finite number");
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
