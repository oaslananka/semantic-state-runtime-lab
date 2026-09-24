import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import {
  link,
  open,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ARTIFACT_STORE_SNAPSHOT_SCHEMA,
  ArtifactBlobCorruptError,
  ArtifactBlobNotFoundError,
  ArtifactBlobReadLimitError,
  ArtifactMutationCollisionError,
  ArtifactMutationMissingBlobError,
  artifactDigest,
  artifactMutationJson,
  normalizeArtifactMediaType,
  normalizeArtifactMutation,
  normalizeArtifactResourceIdentity,
  parseArtifactMutationJson,
  parseStoredArtifactBlobJson,
  storedArtifactBlobJson,
  type ArtifactBlobDescriptor,
  type ArtifactBlobReadRequest,
  type ArtifactBlobReadResult,
  type ArtifactDigest,
  type ArtifactMutation,
  type ArtifactResourceIdentity,
  type ArtifactStore,
  type ArtifactStoreSnapshot,
  type StoredArtifactBlob,
} from "@ssrl/artifact-store";

const STORE_COMPONENT = "local-artifact-store";
const STORE_SCHEMA_VERSION = 1;

export interface LocalArtifactStoreOptions {
  readonly root: string;
  readonly timeoutMs?: number;
  readonly maxReadBytes?: number;
}

interface VersionRow {
  readonly schema_version: number | bigint;
}

interface BlobRow {
  readonly digest: string;
  readonly size: number | bigint;
  readonly record_json: string;
}

interface MutationRow {
  readonly mutation_id: string;
  readonly source_key: string;
  readonly external_type: string;
  readonly external_id: string;
  readonly kind: string;
  readonly effective_at: string;
  readonly recorded_at: string;
  readonly blob_digest: string | null;
  readonly record_json: string;
}

interface JsonRow {
  readonly record_json: string;
}

export class UnsupportedArtifactStoreSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`Artifact store schema version ${found} is newer than supported version ${supported}`);
    this.name = "UnsupportedArtifactStoreSchemaError";
  }
}

export class CorruptLocalArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptLocalArtifactStoreError";
  }
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function sha256Digest(bytes: Uint8Array): ArtifactDigest {
  const encoded = createHash("sha256").update(bytes).digest("hex");
  return artifactDigest(`sha256:${encoded}`);
}

function sha256Encoded(digest: ArtifactDigest): string {
  const normalized = artifactDigest(digest);
  if (!normalized.startsWith("sha256:")) {
    throw new TypeError(`Local artifact store only supports SHA-256 blobs: ${normalized}`);
  }
  return normalized.slice("sha256:".length);
}

function resourceMatchesRow(resource: ArtifactResourceIdentity, row: MutationRow): boolean {
  return resource.sourceKey === row.source_key
    && resource.externalType === row.external_type
    && resource.externalId === row.external_id;
}

export class LocalArtifactStore implements ArtifactStore {
  readonly #blobRoot: string;
  readonly #tempRoot: string;
  readonly #db: DatabaseSync;
  readonly #maxReadBytes: number;

  constructor(options: LocalArtifactStoreOptions) {
    if (options.root.trim().length === 0) throw new TypeError("Artifact store root must not be empty");
    this.#blobRoot = join(options.root, "blobs", "sha256");
    this.#tempRoot = join(options.root, "tmp");
    this.#maxReadBytes = positiveLimit(options.maxReadBytes ?? 4 * 1024 * 1024, "maxReadBytes");
    // DatabaseSync requires its parent directory to exist before opening the metadata DB.
    mkdirSync(this.#blobRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.#tempRoot, { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(join(options.root, "artifacts.sqlite"), {
      timeout: options.timeoutMs ?? 5_000,
      defensive: true,
    });
    try {
      this.#db.exec("PRAGMA foreign_keys = ON");
      this.#initialize();
    } catch (cause) {
      this.#db.close();
      throw cause;
    }
  }

  #initialize(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_store_meta (
        component TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL
      ) STRICT;
    `);
    const versionRow = this.#db.prepare(`
      SELECT schema_version
      FROM artifact_store_meta
      WHERE component = ?
    `).get(STORE_COMPONENT) as VersionRow | undefined;
    if (versionRow !== undefined) {
      const version = Number(versionRow.schema_version);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new CorruptLocalArtifactStoreError(`Invalid artifact schema version ${String(versionRow.schema_version)}`);
      }
      if (version > STORE_SCHEMA_VERSION) {
        throw new UnsupportedArtifactStoreSchemaError(version, STORE_SCHEMA_VERSION);
      }
      if (version === STORE_SCHEMA_VERSION) return;
    }

    const existing = this.#db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('artifact_blobs', 'artifact_mutations')
      ORDER BY name
    `).all() as unknown as { readonly name: string }[];
    if (existing.length > 0) {
      throw new CorruptLocalArtifactStoreError(
        `Artifact tables exist without a schema marker: ${existing.map((row) => row.name).join(", ")}`,
      );
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        CREATE TABLE artifact_blobs (
          digest TEXT PRIMARY KEY,
          size INTEGER NOT NULL CHECK(size >= 0),
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        ) STRICT;

        CREATE TABLE artifact_mutations (
          mutation_id TEXT PRIMARY KEY,
          source_key TEXT NOT NULL,
          external_type TEXT NOT NULL,
          external_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('upsert', 'delete')),
          effective_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          blob_digest TEXT REFERENCES artifact_blobs(digest),
          record_json TEXT NOT NULL CHECK(json_valid(record_json)),
          CHECK(
            (kind = 'upsert' AND blob_digest IS NOT NULL)
            OR (kind = 'delete' AND blob_digest IS NULL)
          )
        ) STRICT;

        CREATE INDEX artifact_mutations_resource_time
          ON artifact_mutations(
            source_key, external_type, external_id,
            effective_at, recorded_at, mutation_id
          );
      `);
      this.#db.prepare(`
        INSERT INTO artifact_store_meta(component, schema_version)
        VALUES (?, ?)
      `).run(STORE_COMPONENT, STORE_SCHEMA_VERSION);
      this.#db.exec("COMMIT");
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  #blobPath(digest: ArtifactDigest): string {
    return join(this.#blobRoot, sha256Encoded(digest));
  }

  #blobRow(digest: ArtifactDigest): BlobRow | undefined {
    return this.#db.prepare(`
      SELECT digest, size, record_json
      FROM artifact_blobs
      WHERE digest = ?
    `).get(digest) as BlobRow | undefined;
  }

  #validatedBlobRow(row: BlobRow): StoredArtifactBlob {
    let parsed: StoredArtifactBlob;
    try {
      parsed = parseStoredArtifactBlobJson(row.record_json);
    } catch (cause) {
      throw new CorruptLocalArtifactStoreError(
        cause instanceof Error ? cause.message : `Artifact blob ${row.digest} metadata is invalid`,
      );
    }
    if (parsed.digest !== row.digest || parsed.size !== Number(row.size)) {
      throw new CorruptLocalArtifactStoreError(`Artifact blob row ${row.digest} disagrees with record_json`);
    }
    return parsed;
  }

  async #fileDigest(path: string): Promise<ArtifactDigest> {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return artifactDigest(`sha256:${hash.digest("hex")}`);
  }

  async #verifyFileShape(blob: StoredArtifactBlob): Promise<string> {
    const path = this.#blobPath(blob.digest);
    let info;
    try {
      info = await stat(path);
    } catch (cause) {
      if (isFsCode(cause, "ENOENT")) {
        throw new ArtifactBlobCorruptError(blob.digest, "content file is missing");
      }
      throw cause;
    }
    if (!info.isFile()) throw new ArtifactBlobCorruptError(blob.digest, "content path is not a file");
    if (info.size !== blob.size) {
      throw new ArtifactBlobCorruptError(blob.digest, `size ${info.size} does not match descriptor ${blob.size}`);
    }
    return path;
  }

  async #verifyFile(blob: StoredArtifactBlob): Promise<void> {
    const path = await this.#verifyFileShape(blob);
    const actual = await this.#fileDigest(path);
    if (actual !== blob.digest) {
      throw new ArtifactBlobCorruptError(blob.digest, `digest verification produced ${actual}`);
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, "r");
      await handle.sync();
    } catch (cause) {
      // Windows does not provide portable directory fsync semantics through fs.open().
      if (
        process.platform === "win32"
        && (isFsCode(cause, "EPERM") || isFsCode(cause, "EISDIR") || isFsCode(cause, "EINVAL"))
      ) {
        return;
      }
      throw cause;
    } finally {
      await handle?.close();
    }
  }

  async #installBlob(bytes: Uint8Array, blob: StoredArtifactBlob): Promise<void> {
    const target = this.#blobPath(blob.digest);
    try {
      await stat(target);
      await this.#verifyFile(blob);
      return;
    } catch (cause) {
      if (!isFsCode(cause, "ENOENT")) throw cause;
    }

    const temporary = join(this.#tempRoot, `${randomUUID()}.blob`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (cause) {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
    await handle.close();

    let installed = false;
    try {
      await link(temporary, target);
      installed = true;
    } catch (cause) {
      if (!isFsCode(cause, "EEXIST")) throw cause;
      await this.#verifyFile(blob);
    } finally {
      await unlink(temporary).catch((cause: unknown) => {
        if (!isFsCode(cause, "ENOENT")) throw cause;
      });
    }
    await this.#verifyFile(blob);
    if (installed) await this.#syncDirectory(this.#blobRoot);
  }

  async putBlob(bytes: Uint8Array, mediaType: string): Promise<ArtifactBlobDescriptor> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Artifact blob bytes must be Uint8Array");
    const descriptor: ArtifactBlobDescriptor = {
      digest: sha256Digest(bytes),
      size: bytes.byteLength,
      mediaType: normalizeArtifactMediaType(mediaType),
    };
    const stored: StoredArtifactBlob = { digest: descriptor.digest, size: descriptor.size };
    await this.#installBlob(bytes, stored);

    const existing = this.#blobRow(descriptor.digest);
    if (existing !== undefined) {
      const previous = this.#validatedBlobRow(existing);
      if (previous.size !== descriptor.size) {
        throw new CorruptLocalArtifactStoreError(`Artifact blob ${descriptor.digest} has conflicting size metadata`);
      }
      return descriptor;
    }
    try {
      this.#db.prepare(`
        INSERT INTO artifact_blobs(digest, size, record_json)
        VALUES (?, ?, ?)
      `).run(descriptor.digest, descriptor.size, storedArtifactBlobJson(stored));
    } catch (cause) {
      const raced = this.#blobRow(descriptor.digest);
      if (raced === undefined) throw cause;
      const previous = this.#validatedBlobRow(raced);
      if (previous.size !== descriptor.size) throw cause;
    }
    return descriptor;
  }

  async headBlob(digest: ArtifactDigest): Promise<StoredArtifactBlob | undefined> {
    const normalized = artifactDigest(digest);
    const row = this.#blobRow(normalized);
    if (row === undefined) return undefined;
    const blob = this.#validatedBlobRow(row);
    await this.#verifyFileShape(blob);
    return blob;
  }

  async readBlobRange(
    digest: ArtifactDigest,
    request: ArtifactBlobReadRequest,
  ): Promise<ArtifactBlobReadResult> {
    const normalized = artifactDigest(digest);
    const blob = await this.headBlob(normalized);
    if (blob === undefined) throw new ArtifactBlobNotFoundError(normalized);
    await this.#verifyFile(blob);

    const maxBytes = Math.min(
      positiveLimit(request.maxBytes, "artifact read maxBytes"),
      this.#maxReadBytes,
    );
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > blob.size) {
      throw new RangeError("artifact read offset must be within the blob");
    }
    const remaining = blob.size - offset;
    const requested = request.length ?? remaining;
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > remaining) {
      throw new RangeError("artifact read length must fit within the blob");
    }
    if (requested > maxBytes) throw new ArtifactBlobReadLimitError(requested, maxBytes);

    const bytes = new Uint8Array(requested);
    if (requested > 0) {
      const handle = await open(this.#blobPath(blob.digest), "r");
      try {
        const { bytesRead } = await handle.read(bytes, 0, requested, offset);
        if (bytesRead !== requested) {
          throw new ArtifactBlobCorruptError(blob.digest, `short read ${bytesRead}/${requested}`);
        }
      } finally {
        await handle.close();
      }
    }
    return {
      ...blob,
      offset,
      bytes,
      complete: offset + requested === blob.size,
    };
  }

  async #requireBlobForMutation(mutation: ArtifactMutation): Promise<void> {
    if (mutation.kind !== "upsert") return;
    const blob = await this.headBlob(mutation.blob.digest);
    if (blob === undefined || blob.size !== mutation.blob.size) {
      throw new ArtifactMutationMissingBlobError(mutation.id, mutation.blob.digest);
    }
    await this.#verifyFile(blob);
  }

  async append(mutations: readonly ArtifactMutation[]): Promise<number> {
    const normalized = mutations
      .map((mutation) => normalizeArtifactMutation(mutation))
      .toSorted((left, right) => left.id.localeCompare(right.id));
    const seen = new Set<string>();
    for (const mutation of normalized) {
      if (seen.has(mutation.id)) throw new Error(`Duplicate artifact mutation id in batch: ${mutation.id}`);
      seen.add(mutation.id);
      await this.#requireBlobForMutation(mutation);
    }

    const find = this.#db.prepare(`
      SELECT record_json
      FROM artifact_mutations
      WHERE mutation_id = ?
    `);
    const insert = this.#db.prepare(`
      INSERT INTO artifact_mutations(
        mutation_id, source_key, external_type, external_id, kind,
        effective_at, recorded_at, blob_digest, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const mutation of normalized) {
        const json = artifactMutationJson(mutation);
        const existing = find.get(mutation.id) as JsonRow | undefined;
        if (existing !== undefined) {
          if (existing.record_json !== json) throw new ArtifactMutationCollisionError(mutation.id);
          continue;
        }
        insert.run(
          mutation.id,
          mutation.resource.sourceKey,
          mutation.resource.externalType,
          mutation.resource.externalId,
          mutation.kind,
          mutation.effectiveAt,
          mutation.recordedAt,
          mutation.kind === "upsert" ? mutation.blob.digest : null,
          json,
        );
        inserted += 1;
      }
      this.#db.exec("COMMIT");
      return inserted;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  #validatedMutationRow(row: MutationRow): ArtifactMutation {
    let mutation: ArtifactMutation;
    try {
      mutation = parseArtifactMutationJson(row.record_json);
    } catch (cause) {
      throw new CorruptLocalArtifactStoreError(
        cause instanceof Error ? cause.message : `Artifact mutation ${row.mutation_id} is invalid`,
      );
    }
    if (
      mutation.id !== row.mutation_id
      || !resourceMatchesRow(mutation.resource, row)
      || mutation.kind !== row.kind
      || mutation.effectiveAt !== row.effective_at
      || mutation.recordedAt !== row.recorded_at
      || (mutation.kind === "upsert" ? mutation.blob.digest : null) !== row.blob_digest
    ) {
      throw new CorruptLocalArtifactStoreError(
        `Artifact mutation row ${row.mutation_id} disagrees with record_json`,
      );
    }
    if (mutation.kind === "upsert") {
      const blobRow = this.#blobRow(mutation.blob.digest);
      if (blobRow === undefined) {
        throw new CorruptLocalArtifactStoreError(
          `Artifact mutation ${mutation.id} references missing blob metadata ${mutation.blob.digest}`,
        );
      }
      const storedBlob = this.#validatedBlobRow(blobRow);
      if (storedBlob.size !== mutation.blob.size) {
        throw new CorruptLocalArtifactStoreError(
          `Artifact mutation ${mutation.id} blob size disagrees with CAS metadata`,
        );
      }
    }
    return mutation;
  }

  async mutation(id: string): Promise<ArtifactMutation | undefined> {
    const row = this.#db.prepare(`
      SELECT mutation_id, source_key, external_type, external_id, kind,
             effective_at, recorded_at, blob_digest, record_json
      FROM artifact_mutations
      WHERE mutation_id = ?
    `).get(id) as MutationRow | undefined;
    return row === undefined ? undefined : this.#validatedMutationRow(row);
  }

  async mutationsForResource(
    resource: ArtifactResourceIdentity,
  ): Promise<readonly ArtifactMutation[]> {
    const normalized = normalizeArtifactResourceIdentity(resource);
    const rows = this.#db.prepare(`
      SELECT mutation_id, source_key, external_type, external_id, kind,
             effective_at, recorded_at, blob_digest, record_json
      FROM artifact_mutations
      WHERE source_key = ? AND external_type = ? AND external_id = ?
      ORDER BY effective_at, recorded_at, mutation_id
    `).all(
      normalized.sourceKey,
      normalized.externalType,
      normalized.externalId,
    ) as unknown as MutationRow[];
    return rows.map((row) => this.#validatedMutationRow(row));
  }

  async snapshot(): Promise<ArtifactStoreSnapshot> {
    const blobs = this.#db.prepare(`
      SELECT digest, size, record_json
      FROM artifact_blobs
      ORDER BY digest
    `).all() as unknown as BlobRow[];
    const mutations = this.#db.prepare(`
      SELECT mutation_id, source_key, external_type, external_id, kind,
             effective_at, recorded_at, blob_digest, record_json
      FROM artifact_mutations
      ORDER BY mutation_id
    `).all() as unknown as MutationRow[];
    return {
      schema: ARTIFACT_STORE_SNAPSHOT_SCHEMA,
      blobs: blobs.map((row) => this.#validatedBlobRow(row)),
      mutations: mutations.map((row) => this.#validatedMutationRow(row)),
    };
  }

  async unreferencedBlobs(): Promise<readonly StoredArtifactBlob[]> {
    const rows = this.#db.prepare(`
      SELECT b.digest, b.size, b.record_json
      FROM artifact_blobs b
      LEFT JOIN artifact_mutations m ON m.blob_digest = b.digest
      WHERE m.mutation_id IS NULL
      ORDER BY b.digest
    `).all() as unknown as BlobRow[];
    return rows.map((row) => this.#validatedBlobRow(row));
  }

  async unindexedCasFiles(): Promise<readonly string[]> {
    const names = (await readdir(this.#blobRoot)).toSorted((left, right) => left.localeCompare(right));
    const indexed = new Set(
      (this.#db.prepare("SELECT digest FROM artifact_blobs").all() as unknown as { readonly digest: string }[])
        .map((row) => sha256Encoded(artifactDigest(row.digest))),
    );
    return names.filter((name) => /^[a-f0-9]{64}$/.test(name) && !indexed.has(name));
  }

  close(): void {
    this.#db.close();
  }
}

function isFsCode(value: unknown, code: string): boolean {
  return value instanceof Error && "code" in value && (value as NodeJS.ErrnoException).code === code;
}

