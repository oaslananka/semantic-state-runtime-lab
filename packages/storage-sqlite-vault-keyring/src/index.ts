import { normalizeAccessPrincipal, type AccessPrincipal } from "@ssrl/access";
import { canonicalJson } from "@ssrl/core";
import {
  epochKeyGrantJson,
  normalizeVaultEpochId,
  parseEpochKeyGrantJson,
  type HpkeEpochKeyGrant,
  type VaultEpochId,
} from "@ssrl/e2e";
import {
  CorruptVaultKeyringError,
  VaultKeyringConflictError,
  authorizedVaultKeyringEventJson,
  deriveActiveVaultEpoch,
  deriveVaultKeyringCommitState,
  normalizeAuthorizedVaultKeyringEvent,
  normalizeVaultEpochRecord,
  orderedVaultEpochsForPrincipal,
  orderedVaultGrantsForEpoch,
  validateVaultKeyringCommit,
  vaultGrantsForRecipientInventory,
  type AuthorizedVaultKeyringEvent,
  type VaultEpochRecord,
  type VaultKeyringCommitResult,
  type VaultKeyringRepository,
} from "@ssrl/vault-keyring";
import { DatabaseSync } from "node:sqlite";

const COMPONENT = "vault-keyring";
const SCHEMA_VERSION = 1;

export interface SQLiteVaultKeyringRepositoryOptions {
  readonly path: string;
  readonly timeoutMs?: number;
  readonly wal?: boolean;
}

interface VersionRow {
  readonly schema_version: number | bigint;
}

interface EpochRow {
  readonly epoch_id: string;
  readonly principal_json: string;
  readonly predecessor_epoch_id: string | null;
  readonly created_at: string;
  readonly reason: string;
  readonly created_by_device_id: string;
  readonly created_by_signing_key_id: string;
  readonly record_json: string;
}

interface GrantRow {
  readonly epoch_id: string;
  readonly recipient_key_id: string;
  readonly grant_json: string;
}

interface EventRow {
  readonly event_id: string;
  readonly operation: string;
  readonly principal_json: string;
  readonly epoch_id: string;
  readonly issuer_device_id: string;
  readonly issuer_signing_key_id: string;
  readonly audience: string;
  readonly created_at: string;
  readonly event_json: string;
}

export class UnsupportedVaultKeyringSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`Vault keyring schema version ${found} is newer than supported version ${supported}`);
    this.name = "UnsupportedVaultKeyringSchemaError";
  }
}

export class CorruptVaultKeyringDatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorruptVaultKeyringDatabaseError";
  }
}

export class SharedVaultKeyringDatabaseNotSupportedError extends Error {
  constructor(readonly tableNames: readonly string[]) {
    super(`Vault keyring requires a dedicated SQLite database; found ${tableNames.join(", ")}`);
    this.name = "SharedVaultKeyringDatabaseNotSupportedError";
  }
}

function parsedObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    throw new CorruptVaultKeyringDatabaseError(`${label} is not valid JSON`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorruptVaultKeyringDatabaseError(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function principalJson(principal: AccessPrincipal): string {
  return canonicalJson(normalizeAccessPrincipal(principal));
}

function samePrincipal(left: AccessPrincipal, right: AccessPrincipal): boolean {
  return principalJson(left) === principalJson(right);
}

function asEpochId(value: string): VaultEpochId {
  return normalizeVaultEpochId(value);
}

function sqliteConstraint(cause: unknown): boolean {
  return cause instanceof Error && /constraint failed|UNIQUE constraint/i.test(cause.message);
}

export class SQLiteVaultKeyringRepository implements VaultKeyringRepository {
  readonly #db: DatabaseSync;
  #commitTail: Promise<void> = Promise.resolve();

  constructor(options: SQLiteVaultKeyringRepositoryOptions) {
    if (options.path.trim().length === 0) throw new TypeError("Vault keyring database path must not be empty");
    this.#db = new DatabaseSync(options.path, {
      timeout: options.timeoutMs ?? 5_000,
      defensive: true,
    });
    try {
      this.#db.exec("PRAGMA foreign_keys = ON");
      if (options.wal === true) this.#db.exec("PRAGMA journal_mode = WAL");
      this.#initialize();
    } catch (cause) {
      this.#db.close();
      throw cause;
    }
  }

  #initialize(): void {
    const meta = this.#db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'vault_keyring_meta'
    `).get() as { readonly present: number } | undefined;
    if (meta === undefined) {
      const existing = this.#db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as unknown as { readonly name: string }[];
      if (existing.length > 0) {
        throw new SharedVaultKeyringDatabaseNotSupportedError(existing.map((row) => row.name));
      }
      this.#createSchema();
      return;
    }

    const row = this.#db.prepare(`
      SELECT schema_version
      FROM vault_keyring_meta
      WHERE component = ?
    `).get(COMPONENT) as VersionRow | undefined;
    if (row === undefined) throw new CorruptVaultKeyringDatabaseError("Vault keyring schema marker is missing");
    const version = Number(row.schema_version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new CorruptVaultKeyringDatabaseError(`Invalid vault keyring schema version ${String(row.schema_version)}`);
    }
    if (version > SCHEMA_VERSION) throw new UnsupportedVaultKeyringSchemaError(version, SCHEMA_VERSION);
    if (version !== SCHEMA_VERSION) {
      throw new CorruptVaultKeyringDatabaseError(`Unsupported vault keyring schema version ${version}`);
    }
  }

  #createSchema(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        CREATE TABLE vault_keyring_meta (
          component TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE vault_epochs (
          epoch_id TEXT PRIMARY KEY,
          principal_json TEXT NOT NULL CHECK(json_valid(principal_json)),
          predecessor_epoch_id TEXT REFERENCES vault_epochs(epoch_id),
          created_at TEXT NOT NULL,
          reason TEXT NOT NULL CHECK(reason IN ('bootstrap', 'recipient-set-change', 'manual')),
          created_by_device_id TEXT NOT NULL,
          created_by_signing_key_id TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json)),
          UNIQUE(predecessor_epoch_id)
        ) STRICT;

        CREATE UNIQUE INDEX vault_epochs_single_root_per_principal
          ON vault_epochs(principal_json)
          WHERE predecessor_epoch_id IS NULL;

        CREATE INDEX vault_epochs_principal_created
          ON vault_epochs(principal_json, created_at, epoch_id);

        CREATE TABLE vault_epoch_grants (
          epoch_id TEXT NOT NULL REFERENCES vault_epochs(epoch_id),
          recipient_key_id TEXT NOT NULL,
          grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
          PRIMARY KEY(epoch_id, recipient_key_id)
        ) STRICT;

        CREATE INDEX vault_epoch_grants_epoch_recipient
          ON vault_epoch_grants(epoch_id, recipient_key_id);

        CREATE TABLE vault_keyring_events (
          event_id TEXT PRIMARY KEY,
          operation TEXT NOT NULL CHECK(operation IN (
            'bootstrap-epoch', 'rotate-epoch', 'extend-historical-grants'
          )),
          principal_json TEXT NOT NULL CHECK(json_valid(principal_json)),
          epoch_id TEXT NOT NULL REFERENCES vault_epochs(epoch_id),
          issuer_device_id TEXT NOT NULL,
          issuer_signing_key_id TEXT NOT NULL,
          audience TEXT NOT NULL,
          created_at TEXT NOT NULL,
          event_json TEXT NOT NULL CHECK(json_valid(event_json))
        ) STRICT;

        CREATE INDEX vault_keyring_events_epoch_created
          ON vault_keyring_events(epoch_id, created_at, event_id);
      `);
      this.#db.prepare(`
        INSERT INTO vault_keyring_meta(component, schema_version)
        VALUES (?, ?)
      `).run(COMPONENT, SCHEMA_VERSION);
      this.#db.exec("COMMIT");
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  #epochFromRow(row: EpochRow): VaultEpochRecord {
    const parsed = parsedObject(row.record_json, `vault epoch ${row.epoch_id}`);
    let epoch: VaultEpochRecord;
    try {
      epoch = normalizeVaultEpochRecord(parsed as unknown as VaultEpochRecord);
    } catch (cause) {
      throw new CorruptVaultKeyringDatabaseError(`vault epoch ${row.epoch_id} is invalid`, { cause });
    }
    const canonical = canonicalJson(epoch);
    if (
      canonical !== row.record_json
      || epoch.epochId !== row.epoch_id
      || principalJson(epoch.principal) !== row.principal_json
      || (epoch.predecessorEpochId ?? null) !== row.predecessor_epoch_id
      || epoch.createdAt !== row.created_at
      || epoch.reason !== row.reason
      || epoch.createdByDeviceId !== row.created_by_device_id
      || epoch.createdBySigningKeyId !== row.created_by_signing_key_id
    ) {
      throw new CorruptVaultKeyringDatabaseError(`vault epoch ${row.epoch_id} indexed columns disagree with record_json`);
    }
    return epoch;
  }

  #grantFromRow(row: GrantRow): HpkeEpochKeyGrant {
    let grant: HpkeEpochKeyGrant;
    try {
      grant = parseEpochKeyGrantJson(row.grant_json);
    } catch (cause) {
      throw new CorruptVaultKeyringDatabaseError(
        `vault grant ${row.epoch_id}/${row.recipient_key_id} is invalid`,
        { cause },
      );
    }
    if (
      epochKeyGrantJson(grant) !== row.grant_json
      || grant.epochId !== row.epoch_id
      || grant.recipientKeyId !== row.recipient_key_id
    ) {
      throw new CorruptVaultKeyringDatabaseError(
        `vault grant ${row.epoch_id}/${row.recipient_key_id} indexed columns disagree with grant_json`,
      );
    }
    return grant;
  }

  async #eventFromRow(row: EventRow): Promise<AuthorizedVaultKeyringEvent> {
    const parsed = parsedObject(row.event_json, `vault keyring event ${row.event_id}`);
    let event: AuthorizedVaultKeyringEvent;
    try {
      event = await normalizeAuthorizedVaultKeyringEvent(parsed as unknown as AuthorizedVaultKeyringEvent);
    } catch (cause) {
      throw new CorruptVaultKeyringDatabaseError(`vault keyring event ${row.event_id} is invalid`, { cause });
    }
    if (
      await authorizedVaultKeyringEventJson(event) !== row.event_json
      || event.transition.eventId !== row.event_id
      || event.transition.operation !== row.operation
      || principalJson(event.transition.principal) !== row.principal_json
      || event.transition.epoch.epochId !== row.epoch_id
      || event.transition.issuerDeviceId !== row.issuer_device_id
      || event.transition.issuerSigningKeyId !== row.issuer_signing_key_id
      || event.transition.audience !== row.audience
      || event.transition.createdAt !== row.created_at
    ) {
      throw new CorruptVaultKeyringDatabaseError(
        `vault keyring event ${row.event_id} indexed columns disagree with event_json`,
      );
    }
    return event;
  }

  #allEpochs(): VaultEpochRecord[] {
    const rows = this.#db.prepare(`
      SELECT epoch_id, principal_json, predecessor_epoch_id, created_at, reason,
             created_by_device_id, created_by_signing_key_id, record_json
      FROM vault_epochs
      ORDER BY created_at, epoch_id
    `).all() as unknown as EpochRow[];
    return rows.map((row) => this.#epochFromRow(row));
  }

  #allGrants(): HpkeEpochKeyGrant[] {
    const rows = this.#db.prepare(`
      SELECT epoch_id, recipient_key_id, grant_json
      FROM vault_epoch_grants
      ORDER BY epoch_id, recipient_key_id
    `).all() as unknown as GrantRow[];
    return rows.map((row) => this.#grantFromRow(row));
  }

  async #allEvents(): Promise<AuthorizedVaultKeyringEvent[]> {
    const rows = this.#db.prepare(`
      SELECT event_id, operation, principal_json, epoch_id,
             issuer_device_id, issuer_signing_key_id, audience, created_at, event_json
      FROM vault_keyring_events
      ORDER BY created_at, event_id
    `).all() as unknown as EventRow[];
    return Promise.all(rows.map((row) => this.#eventFromRow(row)));
  }



  async event(eventId: string): Promise<AuthorizedVaultKeyringEvent | undefined> {
    const id = eventId.trim();
    if (id.length === 0) throw new TypeError("vault keyring eventId must not be empty");
    return (await this.#allEvents()).find((event) => event.transition.eventId === id);
  }

  async epoch(epochId: VaultEpochId): Promise<VaultEpochRecord | undefined> {
    const id = normalizeVaultEpochId(epochId);
    return this.#allEpochs().find((epoch) => epoch.epochId === id);
  }

  async activeEpoch(principal: AccessPrincipal): Promise<VaultEpochRecord | undefined> {
    return deriveActiveVaultEpoch(this.#allEpochs(), principal);
  }

  async epochsForPrincipal(principal: AccessPrincipal): Promise<readonly VaultEpochRecord[]> {
    return orderedVaultEpochsForPrincipal(this.#allEpochs(), principal);
  }

  async grantsForEpoch(epochId: VaultEpochId): Promise<readonly HpkeEpochKeyGrant[]> {
    return orderedVaultGrantsForEpoch(this.#allGrants(), epochId);
  }

  async grant(epochId: VaultEpochId, recipientKeyId: string): Promise<HpkeEpochKeyGrant | undefined> {
    const id = normalizeVaultEpochId(epochId);
    const recipient = recipientKeyId.trim();
    if (recipient.length === 0) throw new TypeError("vault grant recipientKeyId must not be empty");
    return this.#allGrants().find(
      (grant) => grant.epochId === id && grant.recipientKeyId === recipient,
    );
  }

  async #commitSerialized(event: AuthorizedVaultKeyringEvent): Promise<VaultKeyringCommitResult> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const transition = event.transition;
      const events = await this.#allEvents();
      const epochs = this.#allEpochs();
      const grants = this.#allGrants();
      const state = deriveVaultKeyringCommitState({ event, events, epochs, grants });
      const { existingEvent, existingEpoch, existingGrants } = state;
      const outcome = await validateVaultKeyringCommit(event, state);
      const eventJson = outcome === "inserted"
        ? await authorizedVaultKeyringEventJson(event)
        : undefined;
      if (outcome === "inserted") {
        if (transition.operation !== "extend-historical-grants") {
          const epoch = transition.epoch;
          this.#db.prepare(`
            INSERT INTO vault_epochs(
              epoch_id, principal_json, predecessor_epoch_id, created_at, reason,
              created_by_device_id, created_by_signing_key_id, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            epoch.epochId,
            principalJson(epoch.principal),
            epoch.predecessorEpochId ?? null,
            epoch.createdAt,
            epoch.reason,
            epoch.createdByDeviceId,
            epoch.createdBySigningKeyId,
            canonicalJson(epoch),
          );
        }
        for (const grant of transition.grantsAdded) {
          this.#db.prepare(`
            INSERT INTO vault_epoch_grants(epoch_id, recipient_key_id, grant_json)
            VALUES (?, ?, ?)
          `).run(grant.epochId, grant.recipientKeyId, epochKeyGrantJson(grant));
        }
        this.#db.prepare(`
          INSERT INTO vault_keyring_events(
            event_id, operation, principal_json, epoch_id,
            issuer_device_id, issuer_signing_key_id, audience, created_at, event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          transition.eventId,
          transition.operation,
          principalJson(transition.principal),
          transition.epoch.epochId,
          transition.issuerDeviceId,
          transition.issuerSigningKeyId,
          transition.audience,
          transition.createdAt,
          eventJson!,
        );
      }
      this.#db.exec("COMMIT");

      const persistedEvent = existingEvent ?? event;
      const persistedEpoch = existingEpoch ?? transition.epoch;
      const allPersistedGrants = outcome === "inserted"
        ? [...existingGrants, ...transition.grantsAdded]
        : existingGrants;
      const persistedGrants = vaultGrantsForRecipientInventory(
        allPersistedGrants,
        persistedEvent.transition.resultingRecipientKeyIds,
      );
      return { outcome, event: persistedEvent, epoch: persistedEpoch, grants: persistedGrants };
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      if (sqliteConstraint(cause)) {
        throw new VaultKeyringConflictError("vault keyring SQLite constraint rejected transition", { cause });
      }
      throw cause;
    }
  }

  async commit(eventInput: AuthorizedVaultKeyringEvent): Promise<VaultKeyringCommitResult> {
    const event = await normalizeAuthorizedVaultKeyringEvent(eventInput);
    const run = this.#commitTail.then(() => this.#commitSerialized(event));
    this.#commitTail = run.then(() => undefined, () => undefined);
    return run;
  }

  close(): void {
    this.#db.close();
  }
}
