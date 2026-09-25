import { normalizeAccessPrincipal, type AccessPrincipal } from "@ssrl/access";
import { DatabaseSync } from "node:sqlite";
import {
  DeviceTrustAuthorizationError,
  DeviceTrustChallengeError,
  DeviceTrustConflictError,
  deviceTrustChallengeJson,
  deviceRecoveryChallengeJson,
  deviceTrustEventJson,
  normalizeDeviceTrustEvent,
  normalizeTrustedDevice,
  normalizeTrustedDeviceKey,
  normalizeTrustedRecoveryCredential,
  trustedDeviceJson,
  trustedDeviceKeyJson,
  trustedRecoveryCredentialJson,
  validateDeviceRecoveryChallengeKeyIds,
  validateDeviceTrustChallengeKeyId,
  type BootstrapDeviceTransition,
  type DeviceRecoveryChallenge,
  type DeviceTrustChallenge,
  type DeviceTrustEvent,
  type DeviceTrustMutationResult,
  type DeviceTrustRepository,
  type EnrollDeviceTransition,
  type ReplicationDeviceCredential,
  type ReplicationSignatureReplayInput,
  type RecoverTrustSetTransition,
  type RecoveryCredentialMutationResult,
  type RecoveryTrustSetMutationResult,
  type RevokeDeviceTransition,
  type RevokeKeyTransition,
  type RotateKeyTransition,
  type SetRecoveryCredentialTransition,
  type StoredDeviceRecoveryChallenge,
  type StoredDeviceTrustChallenge,
  type TrustedDevice,
  type TrustedDeviceKey,
  type TrustedRecoveryCredential,
} from "@ssrl/device-trust";

const COMPONENT = "device-trust";
const SCHEMA_VERSION = 2;

export interface SQLiteDeviceTrustStoreOptions {
  readonly path: string;
  readonly timeoutMs?: number;
  readonly wal?: boolean;
}

interface VersionRow {
  readonly schema_version: number | bigint;
}

interface DeviceRow {
  readonly device_id: string;
  readonly principal_json: string;
  readonly display_name: string;
  readonly enrolled_at: string;
  readonly status: string;
  readonly revoked_at: string | null;
  readonly record_json: string;
}

interface KeyRow {
  readonly key_id: string;
  readonly device_id: string;
  readonly public_jwk_json: string;
  readonly activated_at: string;
  readonly status: string;
  readonly revoked_at: string | null;
  readonly predecessor_key_id: string | null;
  readonly record_json: string;
}

interface EventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly device_id: string;
  readonly key_id: string | null;
  readonly event_json: string;
}

interface ChallengeRow {
  readonly challenge_id: string;
  readonly operation: string;
  readonly key_id: string;
  readonly authorized_by_device_id: string;
  readonly authorized_by_key_id: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly challenge_json: string;
}

interface ResolveRow {
  readonly key_json: string;
  readonly device_json: string;
}


interface RecoveryCredentialRow {
  readonly key_id: string;
  readonly principal_json: string;
  readonly public_jwk_json: string;
  readonly generation: number | bigint;
  readonly activated_at: string;
  readonly status: string;
  readonly retired_at: string | null;
  readonly predecessor_key_id: string | null;
  readonly record_json: string;
}

interface RecoveryChallengeRow {
  readonly challenge_id: string;
  readonly recovery_key_id: string;
  readonly recovery_generation: number | bigint;
  readonly device_id: string;
  readonly key_id: string;
  readonly next_recovery_key_id: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly challenge_json: string;
}

export class UnsupportedDeviceTrustSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`Device trust schema version ${found} is newer than supported version ${supported}`);
    this.name = "UnsupportedDeviceTrustSchemaError";
  }
}

export class CorruptDeviceTrustDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptDeviceTrustDatabaseError";
  }
}

export class SharedDeviceTrustDatabaseNotSupportedError extends Error {
  constructor(readonly tableNames: readonly string[]) {
    super(`Device trust store requires a dedicated SQLite database; found ${tableNames.join(", ")}`);
    this.name = "SharedDeviceTrustDatabaseNotSupportedError";
  }
}

function canonicalTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function parsedObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new CorruptDeviceTrustDatabaseError(`${label} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorruptDeviceTrustDatabaseError(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function eventKeyId(event: DeviceTrustEvent): string | null {
  return "keyId" in event ? event.keyId : null;
}

function changes(value: number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new CorruptDeviceTrustDatabaseError(`SQLite returned invalid change count ${String(value)}`);
  }
  return result;
}


function corruptSync<T>(label: string, operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof CorruptDeviceTrustDatabaseError) throw cause;
    throw new CorruptDeviceTrustDatabaseError(
      cause instanceof Error ? cause.message : `${label} is corrupt`,
    );
  }
}

async function corruptAsync<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof CorruptDeviceTrustDatabaseError) throw cause;
    throw new CorruptDeviceTrustDatabaseError(
      cause instanceof Error ? cause.message : `${label} is corrupt`,
    );
  }
}

export class SQLiteDeviceTrustStore implements DeviceTrustRepository {
  readonly #db: DatabaseSync;

  constructor(options: SQLiteDeviceTrustStoreOptions) {
    if (options.path.trim().length === 0) throw new TypeError("Device trust database path must not be empty");
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

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  #initialize(): void {
    const metaExists = this.#db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'device_trust_meta'
    `).get() as { readonly present: number } | undefined;
    if (metaExists === undefined) {
      const existing = this.#db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as unknown as { readonly name: string }[];
      if (existing.length > 0) {
        throw new SharedDeviceTrustDatabaseNotSupportedError(existing.map((row) => row.name));
      }
      this.#createSchema();
      return;
    }

    const row = this.#db.prepare(`
      SELECT schema_version
      FROM device_trust_meta
      WHERE component = ?
    `).get(COMPONENT) as VersionRow | undefined;
    if (row === undefined) throw new CorruptDeviceTrustDatabaseError("Device trust schema marker is missing");
    const version = Number(row.schema_version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new CorruptDeviceTrustDatabaseError(`Invalid device trust schema version ${String(row.schema_version)}`);
    }
    if (version > SCHEMA_VERSION) throw new UnsupportedDeviceTrustSchemaError(version, SCHEMA_VERSION);
    if (version === SCHEMA_VERSION) return;
    if (version === 1) {
      this.#migrateV1ToV2();
      return;
    }
    throw new CorruptDeviceTrustDatabaseError(`Unsupported device trust schema version ${version}`);
  }

  #createRecoveryTables(): void {
    this.#db.exec(`
      CREATE TABLE trusted_recovery_credentials (
        key_id TEXT PRIMARY KEY,
        principal_json TEXT NOT NULL CHECK(json_valid(principal_json)),
        public_jwk_json TEXT NOT NULL UNIQUE CHECK(json_valid(public_jwk_json)),
        generation INTEGER NOT NULL CHECK(generation >= 1),
        activated_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
        retired_at TEXT,
        predecessor_key_id TEXT REFERENCES trusted_recovery_credentials(key_id),
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        UNIQUE(principal_json, generation)
      ) STRICT;

      CREATE UNIQUE INDEX trusted_recovery_credentials_active_principal
        ON trusted_recovery_credentials(principal_json)
        WHERE status = 'active';

      CREATE TABLE device_recovery_challenges (
        challenge_id TEXT PRIMARY KEY,
        recovery_key_id TEXT NOT NULL REFERENCES trusted_recovery_credentials(key_id),
        recovery_generation INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        next_recovery_key_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        challenge_json TEXT NOT NULL CHECK(json_valid(challenge_json))
      ) STRICT;

      CREATE INDEX device_recovery_challenges_expiry
        ON device_recovery_challenges(expires_at, consumed_at, challenge_id);
    `);
  }

  #migrateV1ToV2(): void {
    this.#transaction(() => {
      this.#createRecoveryTables();
      this.#db.exec(`
        ALTER TABLE device_trust_events RENAME TO device_trust_events_v1;
        CREATE TABLE device_trust_events (
          event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL CHECK(event_type IN (
            'bootstrap-device', 'enroll-device', 'rotate-key', 'revoke-key', 'revoke-device',
            'set-recovery-credential', 'recover-trust-set'
          )),
          device_id TEXT NOT NULL,
          key_id TEXT,
          occurred_at TEXT NOT NULL,
          event_json TEXT NOT NULL CHECK(json_valid(event_json))
        ) STRICT;
        INSERT INTO device_trust_events(event_id, event_type, device_id, key_id, occurred_at, event_json)
        SELECT event_id, event_type, device_id, key_id, occurred_at, event_json
        FROM device_trust_events_v1;
        DROP TABLE device_trust_events_v1;
        CREATE INDEX device_trust_events_device_time
          ON device_trust_events(device_id, occurred_at, event_id);
      `);
      this.#db.prepare(`
        UPDATE device_trust_meta
        SET schema_version = ?
        WHERE component = ?
      `).run(SCHEMA_VERSION, COMPONENT);
    });
  }

  #createSchema(): void {
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE device_trust_meta (
          component TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE trusted_devices (
          device_id TEXT PRIMARY KEY,
          principal_json TEXT NOT NULL CHECK(json_valid(principal_json)),
          display_name TEXT NOT NULL,
          enrolled_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
          revoked_at TEXT,
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        ) STRICT;

        CREATE INDEX trusted_devices_principal_status
          ON trusted_devices(principal_json, status, device_id);

        CREATE TABLE trusted_device_keys (
          key_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL REFERENCES trusted_devices(device_id),
          public_jwk_json TEXT NOT NULL UNIQUE CHECK(json_valid(public_jwk_json)),
          activated_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
          revoked_at TEXT,
          predecessor_key_id TEXT REFERENCES trusted_device_keys(key_id),
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        ) STRICT;

        CREATE INDEX trusted_device_keys_device_status
          ON trusted_device_keys(device_id, status, activated_at, key_id);

        CREATE TABLE device_trust_events (
          event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL CHECK(event_type IN (
            'bootstrap-device', 'enroll-device', 'rotate-key', 'revoke-key', 'revoke-device',
            'set-recovery-credential', 'recover-trust-set'
          )),
          device_id TEXT NOT NULL,
          key_id TEXT,
          occurred_at TEXT NOT NULL,
          event_json TEXT NOT NULL CHECK(json_valid(event_json))
        ) STRICT;

        CREATE INDEX device_trust_events_device_time
          ON device_trust_events(device_id, occurred_at, event_id);

        CREATE TABLE device_trust_challenges (
          challenge_id TEXT PRIMARY KEY,
          operation TEXT NOT NULL CHECK(operation IN ('enroll-device', 'rotate-key')),
          key_id TEXT NOT NULL,
          authorized_by_device_id TEXT NOT NULL REFERENCES trusted_devices(device_id),
          authorized_by_key_id TEXT NOT NULL REFERENCES trusted_device_keys(key_id),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          challenge_json TEXT NOT NULL CHECK(json_valid(challenge_json))
        ) STRICT;

        CREATE INDEX device_trust_challenges_expiry
          ON device_trust_challenges(expires_at, consumed_at, challenge_id);

        CREATE TABLE replication_signature_replays (
          key_id TEXT NOT NULL REFERENCES trusted_device_keys(key_id),
          nonce TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY(key_id, nonce)
        ) STRICT;

        CREATE INDEX replication_signature_replays_expiry
          ON replication_signature_replays(expires_at, key_id, nonce);

        CREATE TABLE trusted_recovery_credentials (
          key_id TEXT PRIMARY KEY,
          principal_json TEXT NOT NULL CHECK(json_valid(principal_json)),
          public_jwk_json TEXT NOT NULL UNIQUE CHECK(json_valid(public_jwk_json)),
          generation INTEGER NOT NULL CHECK(generation >= 1),
          activated_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
          retired_at TEXT,
          predecessor_key_id TEXT REFERENCES trusted_recovery_credentials(key_id),
          record_json TEXT NOT NULL CHECK(json_valid(record_json)),
          UNIQUE(principal_json, generation)
        ) STRICT;

        CREATE UNIQUE INDEX trusted_recovery_credentials_active_principal
          ON trusted_recovery_credentials(principal_json)
          WHERE status = 'active';

        CREATE TABLE device_recovery_challenges (
          challenge_id TEXT PRIMARY KEY,
          recovery_key_id TEXT NOT NULL REFERENCES trusted_recovery_credentials(key_id),
          recovery_generation INTEGER NOT NULL,
          device_id TEXT NOT NULL,
          key_id TEXT NOT NULL,
          next_recovery_key_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          challenge_json TEXT NOT NULL CHECK(json_valid(challenge_json))
        ) STRICT;

        CREATE INDEX device_recovery_challenges_expiry
          ON device_recovery_challenges(expires_at, consumed_at, challenge_id);
      `);
      this.#db.prepare(`
        INSERT INTO device_trust_meta(component, schema_version)
        VALUES (?, ?)
      `).run(COMPONENT, SCHEMA_VERSION);
    });
  }

  #deviceRow(deviceId: string): DeviceRow | undefined {
    return this.#db.prepare(`
      SELECT device_id, principal_json, display_name, enrolled_at, status, revoked_at, record_json
      FROM trusted_devices
      WHERE device_id = ?
    `).get(deviceId) as DeviceRow | undefined;
  }

  #keyRow(keyId: string): KeyRow | undefined {
    return this.#db.prepare(`
      SELECT key_id, device_id, public_jwk_json, activated_at, status,
             revoked_at, predecessor_key_id, record_json
      FROM trusted_device_keys
      WHERE key_id = ?
    `).get(keyId) as KeyRow | undefined;
  }

  #recoveryCredentialRow(keyId: string): RecoveryCredentialRow | undefined {
    return this.#db.prepare(`
      SELECT key_id, principal_json, public_jwk_json, generation, activated_at,
             status, retired_at, predecessor_key_id, record_json
      FROM trusted_recovery_credentials
      WHERE key_id = ?
    `).get(keyId) as RecoveryCredentialRow | undefined;
  }

  #eventRow(eventId: string): EventRow | undefined {
    return this.#db.prepare(`
      SELECT event_id, event_type, device_id, key_id, event_json
      FROM device_trust_events
      WHERE event_id = ?
    `).get(eventId) as EventRow | undefined;
  }

  async #validatedDeviceRow(row: DeviceRow): Promise<TrustedDevice> {
    const device = corruptSync(`Device ${row.device_id}`, () => normalizeTrustedDevice(
      parsedObject(row.record_json, `device ${row.device_id}`) as unknown as TrustedDevice,
    ));
    if (
      device.deviceId !== row.device_id
      || JSON.stringify(device.principal) !== row.principal_json
      || device.displayName !== row.display_name
      || device.enrolledAt !== row.enrolled_at
      || device.status !== row.status
      || (device.revokedAt ?? null) !== row.revoked_at
      || trustedDeviceJson(device) !== row.record_json
    ) {
      throw new CorruptDeviceTrustDatabaseError(`Device row ${row.device_id} disagrees with record_json`);
    }
    return device;
  }

  async #validatedKeyRow(row: KeyRow): Promise<TrustedDeviceKey> {
    const key = await corruptAsync(`Device key ${row.key_id}`, () => normalizeTrustedDeviceKey(
      parsedObject(row.record_json, `key ${row.key_id}`) as unknown as TrustedDeviceKey,
    ));
    if (
      key.keyId !== row.key_id
      || key.deviceId !== row.device_id
      || JSON.stringify(key.publicKeyJwk) !== row.public_jwk_json
      || key.activatedAt !== row.activated_at
      || key.status !== row.status
      || (key.revokedAt ?? null) !== row.revoked_at
      || (key.predecessorKeyId ?? null) !== row.predecessor_key_id
      || await trustedDeviceKeyJson(key) !== row.record_json
    ) {
      throw new CorruptDeviceTrustDatabaseError(`Device key row ${row.key_id} disagrees with record_json`);
    }
    return key;
  }

  async #validatedRecoveryCredentialRow(
    row: RecoveryCredentialRow,
  ): Promise<TrustedRecoveryCredential> {
    const credential = await corruptAsync(
      `Recovery credential ${row.key_id}`,
      () => normalizeTrustedRecoveryCredential(
        parsedObject(
          row.record_json,
          `recovery credential ${row.key_id}`,
        ) as unknown as TrustedRecoveryCredential,
      ),
    );
    if (
      credential.keyId !== row.key_id
      || JSON.stringify(credential.principal) !== row.principal_json
      || JSON.stringify(credential.publicKeyJwk) !== row.public_jwk_json
      || credential.generation !== Number(row.generation)
      || credential.activatedAt !== row.activated_at
      || credential.status !== row.status
      || (credential.retiredAt ?? null) !== row.retired_at
      || (credential.predecessorKeyId ?? null) !== row.predecessor_key_id
      || await trustedRecoveryCredentialJson(credential) !== row.record_json
    ) {
      throw new CorruptDeviceTrustDatabaseError(
        `Recovery credential row ${row.key_id} disagrees with record_json`,
      );
    }
    return credential;
  }

  #validatedEventRow(row: EventRow): DeviceTrustEvent {
    const event = corruptSync(`Device trust event ${row.event_id}`, () => normalizeDeviceTrustEvent(
      parsedObject(row.event_json, `event ${row.event_id}`) as unknown as DeviceTrustEvent,
    ));
    if (
      event.eventId !== row.event_id
      || event.type !== row.event_type
      || event.deviceId !== row.device_id
      || eventKeyId(event) !== row.key_id
      || deviceTrustEventJson(event) !== row.event_json
    ) {
      throw new CorruptDeviceTrustDatabaseError(`Event row ${row.event_id} disagrees with event_json`);
    }
    return event;
  }

  async #validatedChallengeRow(row: ChallengeRow): Promise<StoredDeviceTrustChallenge> {
    const challenge = await corruptAsync(
      `Device trust challenge ${row.challenge_id}`,
      () => validateDeviceTrustChallengeKeyId(
        parsedObject(
          row.challenge_json,
          `challenge ${row.challenge_id}`,
        ) as unknown as DeviceTrustChallenge,
      ),
    );
    if (
      challenge.challengeId !== row.challenge_id
      || challenge.operation !== row.operation
      || challenge.keyId !== row.key_id
      || challenge.authorizedByDeviceId !== row.authorized_by_device_id
      || challenge.authorizedByKeyId !== row.authorized_by_key_id
      || challenge.expiresAt !== row.expires_at
      || deviceTrustChallengeJson(challenge) !== row.challenge_json
    ) {
      throw new CorruptDeviceTrustDatabaseError(
        `Challenge row ${row.challenge_id} disagrees with challenge_json`,
      );
    }
    return {
      challenge,
      ...(row.consumed_at === null ? {} : { consumedAt: canonicalTimestamp(row.consumed_at, "consumedAt") }),
    };
  }

  async #validatedRecoveryChallengeRow(
    row: RecoveryChallengeRow,
  ): Promise<StoredDeviceRecoveryChallenge> {
    const challenge = await corruptAsync(
      `Device recovery challenge ${row.challenge_id}`,
      () => validateDeviceRecoveryChallengeKeyIds(
        parsedObject(
          row.challenge_json,
          `recovery challenge ${row.challenge_id}`,
        ) as unknown as DeviceRecoveryChallenge,
      ),
    );
    if (
      challenge.challengeId !== row.challenge_id
      || challenge.recoveryKeyId !== row.recovery_key_id
      || challenge.recoveryGeneration !== Number(row.recovery_generation)
      || challenge.deviceId !== row.device_id
      || challenge.keyId !== row.key_id
      || challenge.nextRecoveryKeyId !== row.next_recovery_key_id
      || challenge.expiresAt !== row.expires_at
      || await deviceRecoveryChallengeJson(challenge) !== row.challenge_json
    ) {
      throw new CorruptDeviceTrustDatabaseError(
        `Recovery challenge row ${row.challenge_id} disagrees with challenge_json`,
      );
    }
    return {
      challenge,
      ...(row.consumed_at === null
        ? {}
        : { consumedAt: canonicalTimestamp(row.consumed_at, "recovery consumedAt") }),
    };
  }

  #eventReplay(event: DeviceTrustEvent): boolean {
    const row = this.#eventRow(event.eventId);
    if (row === undefined) return false;
    if (row.event_json !== deviceTrustEventJson(event)) {
      throw new DeviceTrustConflictError(`device trust event ${event.eventId} collides with different content`);
    }
    return true;
  }

  #insertEvent(event: DeviceTrustEvent): void {
    this.#db.prepare(`
      INSERT INTO device_trust_events(event_id, event_type, device_id, key_id, occurred_at, event_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.type,
      event.deviceId,
      eventKeyId(event),
      event.occurredAt,
      deviceTrustEventJson(event),
    );
  }

  #insertDevice(device: TrustedDevice): void {
    this.#db.prepare(`
      INSERT INTO trusted_devices(
        device_id, principal_json, display_name, enrolled_at, status, revoked_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      device.deviceId,
      JSON.stringify(device.principal),
      device.displayName,
      device.enrolledAt,
      device.status,
      device.revokedAt ?? null,
      trustedDeviceJson(device),
    );
  }



  #insertRecoveryCredential(credential: TrustedRecoveryCredential, recordJson: string): void {
    this.#db.prepare(`
      INSERT INTO trusted_recovery_credentials(
        key_id, principal_json, public_jwk_json, generation, activated_at,
        status, retired_at, predecessor_key_id, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      credential.keyId,
      JSON.stringify(credential.principal),
      JSON.stringify(credential.publicKeyJwk),
      credential.generation,
      credential.activatedAt,
      credential.status,
      credential.retiredAt ?? null,
      credential.predecessorKeyId ?? null,
      recordJson,
    );
  }

  async #retiredRecoveryUpdate(
    credential: TrustedRecoveryCredential,
    now: string,
  ): Promise<{ readonly before: string; readonly after: string }> {
    return {
      before: await trustedRecoveryCredentialJson(credential),
      after: await trustedRecoveryCredentialJson(await normalizeTrustedRecoveryCredential({
        ...credential,
        status: "retired",
        retiredAt: now,
      })),
    };
  }

  #updateActiveRecoveryCredential(
    keyId: string,
    before: string,
    after: string,
    now: string,
  ): void {
    const updated = this.#db.prepare(`
      UPDATE trusted_recovery_credentials
      SET status = 'retired', retired_at = ?, record_json = ?
      WHERE key_id = ? AND status = 'active' AND record_json = ?
    `).run(now, after, keyId, before);
    if (changes(updated.changes) !== 1) {
      throw new DeviceTrustConflictError("recovery credential changed during retirement");
    }
  }

  #assertChallengeUsable(challenge: DeviceTrustChallenge, now: string): void {
    const row = this.#db.prepare(`
      SELECT challenge_id, operation, key_id, authorized_by_device_id,
             authorized_by_key_id, expires_at, consumed_at, challenge_json
      FROM device_trust_challenges
      WHERE challenge_id = ?
    `).get(challenge.challengeId) as ChallengeRow | undefined;
    if (row === undefined || row.challenge_json !== deviceTrustChallengeJson(challenge)) {
      throw new DeviceTrustChallengeError("device trust challenge does not match durable registry state");
    }
    if (row.consumed_at !== null) throw new DeviceTrustChallengeError("device trust challenge has already been consumed");
    if (Date.parse(row.expires_at) < Date.parse(now)) throw new DeviceTrustChallengeError("device trust challenge has expired");
  }

  #consumeChallenge(challengeId: string, now: string): void {
    const result = this.#db.prepare(`
      UPDATE device_trust_challenges
      SET consumed_at = ?
      WHERE challenge_id = ? AND consumed_at IS NULL
    `).run(now, challengeId);
    if (changes(result.changes) !== 1) {
      throw new DeviceTrustChallengeError("device trust challenge could not be consumed exactly once");
    }
  }

  #assertRecoveryChallengeUsable(
    challenge: DeviceRecoveryChallenge,
    challengeJson: string,
    now: string,
  ): void {
    const row = this.#db.prepare(`
      SELECT challenge_id, recovery_key_id, recovery_generation, device_id, key_id,
             next_recovery_key_id, expires_at, consumed_at, challenge_json
      FROM device_recovery_challenges
      WHERE challenge_id = ?
    `).get(challenge.challengeId) as RecoveryChallengeRow | undefined;
    if (row?.challenge_json !== challengeJson) {
      throw new DeviceTrustChallengeError("device recovery challenge does not match durable registry state");
    }
    if (row.consumed_at !== null) {
      throw new DeviceTrustChallengeError("device recovery challenge has already been consumed");
    }
    if (Date.parse(row.expires_at) < Date.parse(now)) {
      throw new DeviceTrustChallengeError("device recovery challenge has expired");
    }
  }

  #consumeRecoveryChallenge(challengeId: string, now: string): void {
    const result = this.#db.prepare(`
      UPDATE device_recovery_challenges
      SET consumed_at = ?
      WHERE challenge_id = ? AND consumed_at IS NULL
    `).run(now, challengeId);
    if (changes(result.changes) !== 1) {
      throw new DeviceTrustChallengeError("device recovery challenge could not be consumed exactly once");
    }
  }

  #activeActor(event: DeviceTrustEvent): { readonly device: DeviceRow; readonly key: KeyRow } {
    if (event.actor.mode !== "trusted-device") {
      throw new DeviceTrustAuthorizationError("trust-management event requires trusted-device actor");
    }
    const key = this.#keyRow(event.actor.keyId);
    if (key?.status !== "active" || key.device_id !== event.actor.deviceId) {
      throw new DeviceTrustAuthorizationError("trust-management actor key is not active");
    }
    const device = this.#deviceRow(event.actor.deviceId);
    if (device?.status !== "active") {
      throw new DeviceTrustAuthorizationError("trust-management actor device is not active");
    }
    if (device.principal_json !== JSON.stringify(event.principal)) {
      throw new DeviceTrustAuthorizationError("trust-management actor principal does not match event principal");
    }
    return { device, key };
  }

  async #materializedDeviceAndKey(
    deviceId: string,
    keyId: string,
    label: string,
  ): Promise<{ readonly device: TrustedDevice; readonly key: TrustedDeviceKey }> {
    const [device, key] = await Promise.all([this.device(deviceId), this.key(keyId)]);
    if (device === undefined || key === undefined) {
      throw new CorruptDeviceTrustDatabaseError(`${label} materialized state is missing`);
    }
    return { device, key };
  }

  async #revokedKeyUpdate(key: TrustedDeviceKey, now: string): Promise<{
    readonly before: string;
    readonly after: string;
  }> {
    return {
      before: await trustedDeviceKeyJson(key),
      after: await trustedDeviceKeyJson(await normalizeTrustedDeviceKey({
        ...key,
        status: "revoked",
        revokedAt: now,
      })),
    };
  }

  #updateActiveKey(
    keyId: string,
    before: string,
    after: string,
    now: string,
    label: string,
  ): void {
    const updated = this.#db.prepare(`
      UPDATE trusted_device_keys
      SET status = 'revoked', revoked_at = ?, record_json = ?
      WHERE key_id = ? AND status = 'active' AND record_json = ?
    `).run(now, after, keyId, before);
    if (changes(updated.changes) !== 1) {
      throw new DeviceTrustConflictError(`${label} changed during revocation`);
    }
  }

  async isEmpty(): Promise<boolean> {
    const row = this.#db.prepare("SELECT COUNT(*) AS count FROM trusted_devices").get() as { readonly count: number | bigint };
    return Number(row.count) === 0;
  }

  async device(deviceId: string): Promise<TrustedDevice | undefined> {
    const row = this.#deviceRow(deviceId);
    return row === undefined ? undefined : this.#validatedDeviceRow(row);
  }

  async key(keyId: string): Promise<TrustedDeviceKey | undefined> {
    const row = this.#keyRow(keyId);
    return row === undefined ? undefined : this.#validatedKeyRow(row);
  }

  async event(eventId: string): Promise<DeviceTrustEvent | undefined> {
    const row = this.#eventRow(eventId);
    return row === undefined ? undefined : this.#validatedEventRow(row);
  }

  async challenge(challengeId: string): Promise<StoredDeviceTrustChallenge | undefined> {
    const row = this.#db.prepare(`
      SELECT challenge_id, operation, key_id, authorized_by_device_id,
             authorized_by_key_id, expires_at, consumed_at, challenge_json
      FROM device_trust_challenges
      WHERE challenge_id = ?
    `).get(challengeId) as ChallengeRow | undefined;
    return row === undefined ? undefined : this.#validatedChallengeRow(row);
  }

  async recoveryCredential(keyId: string): Promise<TrustedRecoveryCredential | undefined> {
    const row = this.#recoveryCredentialRow(keyId);
    return row === undefined ? undefined : this.#validatedRecoveryCredentialRow(row);
  }

  async activeRecoveryCredential(
    principal: AccessPrincipal,
  ): Promise<TrustedRecoveryCredential | undefined> {
    const row = this.#db.prepare(`
      SELECT key_id, principal_json, public_jwk_json, generation, activated_at,
             status, retired_at, predecessor_key_id, record_json
      FROM trusted_recovery_credentials
      WHERE principal_json = ? AND status = 'active'
    `).get(JSON.stringify(normalizeAccessPrincipal(principal))) as RecoveryCredentialRow | undefined;
    return row === undefined ? undefined : this.#validatedRecoveryCredentialRow(row);
  }

  async recoveryChallenge(
    challengeId: string,
  ): Promise<StoredDeviceRecoveryChallenge | undefined> {
    const row = this.#db.prepare(`
      SELECT challenge_id, recovery_key_id, recovery_generation, device_id, key_id,
             next_recovery_key_id, expires_at, consumed_at, challenge_json
      FROM device_recovery_challenges
      WHERE challenge_id = ?
    `).get(challengeId) as RecoveryChallengeRow | undefined;
    return row === undefined ? undefined : this.#validatedRecoveryChallengeRow(row);
  }

  async resolve(keyId: string): Promise<ReplicationDeviceCredential | undefined> {
    const row = this.#db.prepare(`
      SELECT k.record_json AS key_json, d.record_json AS device_json
      FROM trusted_device_keys k
      JOIN trusted_devices d ON d.device_id = k.device_id
      WHERE k.key_id = ? AND k.status = 'active' AND d.status = 'active'
    `).get(keyId) as ResolveRow | undefined;
    if (row === undefined) return undefined;
    const key = await this.#validatedKeyRow({ ...this.#keyRow(keyId)!, record_json: row.key_json });
    const device = await this.#validatedDeviceRow({ ...this.#deviceRow(key.deviceId)!, record_json: row.device_json });
    return {
      keyId: key.keyId,
      publicKeyJwk: key.publicKeyJwk,
      principal: device.principal,
      status: "active",
      deviceId: device.deviceId,
    };
  }

  async issueChallenge(challengeInput: DeviceTrustChallenge): Promise<void> {
    const challenge = await validateDeviceTrustChallengeKeyId(challengeInput);
    this.#transaction(() => {
      const actorKey = this.#keyRow(challenge.authorizedByKeyId);
      const actorDevice = this.#deviceRow(challenge.authorizedByDeviceId);
      if (
        actorKey === undefined
        || actorDevice === undefined
        || actorKey.status !== "active"
        || actorDevice.status !== "active"
        || actorKey.device_id !== actorDevice.device_id
        || actorDevice.principal_json !== JSON.stringify(challenge.principal)
      ) {
        throw new DeviceTrustAuthorizationError("challenge authorizer is not an active matching device key");
      }
      if (this.#keyRow(challenge.keyId) !== undefined) {
        throw new DeviceTrustConflictError("proposed device key already exists in trust registry");
      }
      if (challenge.operation === "enroll-device" && this.#deviceRow(challenge.deviceId) !== undefined) {
        throw new DeviceTrustConflictError(`device ${challenge.deviceId} already exists`);
      }
      if (challenge.operation === "rotate-key" && challenge.deviceId !== actorDevice.device_id) {
        throw new DeviceTrustAuthorizationError("rotation challenge must target the authorizing device");
      }
      const json = deviceTrustChallengeJson(challenge);
      const existing = this.#db.prepare(`
        SELECT challenge_json FROM device_trust_challenges WHERE challenge_id = ?
      `).get(challenge.challengeId) as { readonly challenge_json: string } | undefined;
      if (existing !== undefined) {
        if (existing.challenge_json !== json) {
          throw new DeviceTrustConflictError(`challenge ${challenge.challengeId} collides with different content`);
        }
        return;
      }
      this.#db.prepare(`
        INSERT INTO device_trust_challenges(
          challenge_id, operation, key_id, authorized_by_device_id, authorized_by_key_id,
          created_at, expires_at, consumed_at, challenge_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        challenge.challengeId,
        challenge.operation,
        challenge.keyId,
        challenge.authorizedByDeviceId,
        challenge.authorizedByKeyId,
        challenge.createdAt,
        challenge.expiresAt,
        json,
      );
    });
  }

  async issueRecoveryChallenge(challengeInput: DeviceRecoveryChallenge): Promise<void> {
    const challenge = await validateDeviceRecoveryChallengeKeyIds(challengeInput);
    const json = await deviceRecoveryChallengeJson(challenge);
    this.#transaction(() => {
      const current = this.#recoveryCredentialRow(challenge.recoveryKeyId);
      if (
        current?.status !== "active"
        || Number(current?.generation) !== challenge.recoveryGeneration
        || current?.principal_json !== JSON.stringify(challenge.principal)
        || current?.public_jwk_json !== JSON.stringify(challenge.recoveryPublicKeyJwk)
      ) {
        throw new DeviceTrustAuthorizationError("recovery challenge authorizer is not active");
      }
      if (this.#deviceRow(challenge.deviceId) !== undefined) {
        throw new DeviceTrustConflictError("recovery replacement deviceId must be fresh");
      }
      if (
        this.#keyRow(challenge.keyId) !== undefined
        || this.#recoveryCredentialRow(challenge.keyId) !== undefined
      ) {
        throw new DeviceTrustConflictError("recovery replacement device key must be fresh");
      }
      if (
        this.#keyRow(challenge.nextRecoveryKeyId) !== undefined
        || this.#recoveryCredentialRow(challenge.nextRecoveryKeyId) !== undefined
      ) {
        throw new DeviceTrustConflictError("next recovery key must be fresh");
      }
      const existing = this.#db.prepare(`
        SELECT challenge_json FROM device_recovery_challenges WHERE challenge_id = ?
      `).get(challenge.challengeId) as { readonly challenge_json: string } | undefined;
      if (existing !== undefined) {
        if (existing.challenge_json !== json) {
          throw new DeviceTrustConflictError(
            `recovery challenge ${challenge.challengeId} collides with different content`,
          );
        }
        return;
      }
      this.#db.prepare(`
        INSERT INTO device_recovery_challenges(
          challenge_id, recovery_key_id, recovery_generation, device_id, key_id,
          next_recovery_key_id, created_at, expires_at, consumed_at, challenge_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        challenge.challengeId,
        challenge.recoveryKeyId,
        challenge.recoveryGeneration,
        challenge.deviceId,
        challenge.keyId,
        challenge.nextRecoveryKeyId,
        challenge.createdAt,
        challenge.expiresAt,
        json,
      );
    });
  }

  async bootstrapDevice(transition: BootstrapDeviceTransition): Promise<DeviceTrustMutationResult> {
    const event = normalizeDeviceTrustEvent(transition.event) as BootstrapDeviceTransition["event"];
    const device = normalizeTrustedDevice(transition.device);
    const key = await normalizeTrustedDeviceKey(transition.key);
    const keyJson = await trustedDeviceKeyJson(key);
    if (
      event.type !== "bootstrap-device"
      || event.deviceId !== device.deviceId
      || event.keyId !== key.keyId
      || key.deviceId !== device.deviceId
      || JSON.stringify(event.principal) !== JSON.stringify(device.principal)
    ) {
      throw new DeviceTrustConflictError("bootstrap transition records do not agree");
    }
    const outcome = this.#transaction((): "inserted" | "replayed" => {
      if (this.#eventReplay(event)) return "replayed";
      const count = this.#db.prepare("SELECT COUNT(*) AS count FROM trusted_devices").get() as { readonly count: number | bigint };
      if (Number(count.count) !== 0) {
        throw new DeviceTrustConflictError("local bootstrap is allowed only for an empty trust registry");
      }
      this.#insertDevice(device);
      this.#db.prepare(`
        INSERT INTO trusted_device_keys(
          key_id, device_id, public_jwk_json, activated_at, status,
          revoked_at, predecessor_key_id, record_json
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        key.keyId,
        key.deviceId,
        JSON.stringify(key.publicKeyJwk),
        key.activatedAt,
        key.status,
        keyJson,
      );
      this.#insertEvent(event);
      return "inserted";
    });
    const materialized = await this.#materializedDeviceAndKey(device.deviceId, key.keyId, "bootstrap");
    return { outcome, event, ...materialized };
  }

  async enrollDevice(transition: EnrollDeviceTransition): Promise<DeviceTrustMutationResult> {
    const event = normalizeDeviceTrustEvent(transition.event) as EnrollDeviceTransition["event"];
    const challenge = await validateDeviceTrustChallengeKeyId(transition.challenge);
    const device = normalizeTrustedDevice(transition.device);
    const key = await normalizeTrustedDeviceKey(transition.key);
    const now = canonicalTimestamp(transition.now, "enrollment now");
    if (
      event.type !== "enroll-device"
      || event.challengeId !== challenge.challengeId
      || event.deviceId !== device.deviceId
      || event.keyId !== key.keyId
      || key.deviceId !== device.deviceId
      || challenge.deviceId !== device.deviceId
      || challenge.keyId !== key.keyId
      || JSON.stringify(event.principal) !== JSON.stringify(device.principal)
      || JSON.stringify(challenge.principal) !== JSON.stringify(device.principal)
    ) {
      throw new DeviceTrustConflictError("enrollment transition records do not agree");
    }
    const keyJson = await trustedDeviceKeyJson(key);
    const outcome = this.#transaction((): "inserted" | "replayed" => {
      if (this.#eventReplay(event)) return "replayed";
      this.#assertChallengeUsable(challenge, now);
      const actor = this.#activeActor(event);
      if (
        event.actor.mode !== "trusted-device"
        || event.actor.deviceId !== challenge.authorizedByDeviceId
        || event.actor.keyId !== challenge.authorizedByKeyId
        || actor.device.principal_json !== JSON.stringify(challenge.principal)
      ) {
        throw new DeviceTrustAuthorizationError("enrollment actor does not match challenge authorization");
      }
      if (this.#deviceRow(device.deviceId) !== undefined) {
        throw new DeviceTrustConflictError(`device ${device.deviceId} already exists`);
      }
      if (this.#keyRow(key.keyId) !== undefined) {
        throw new DeviceTrustConflictError("device key already exists and cannot be rebound");
      }
      this.#insertDevice(device);
      this.#db.prepare(`
        INSERT INTO trusted_device_keys(
          key_id, device_id, public_jwk_json, activated_at, status,
          revoked_at, predecessor_key_id, record_json
        ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, ?)
      `).run(key.keyId, key.deviceId, JSON.stringify(key.publicKeyJwk), key.activatedAt, keyJson);
      this.#insertEvent(event);
      this.#consumeChallenge(challenge.challengeId, now);
      return "inserted";
    });
    const materialized = await this.#materializedDeviceAndKey(device.deviceId, key.keyId, "enrollment");
    return { outcome, event, ...materialized };
  }

  async rotateKey(transition: RotateKeyTransition): Promise<DeviceTrustMutationResult> {
    const event = normalizeDeviceTrustEvent(transition.event) as RotateKeyTransition["event"];
    const challenge = await validateDeviceTrustChallengeKeyId(transition.challenge);
    const key = await normalizeTrustedDeviceKey(transition.key);
    const now = canonicalTimestamp(transition.now, "rotation now");
    const predecessor = await this.key(transition.predecessorKeyId);
    if (predecessor === undefined) throw new DeviceTrustConflictError("rotation predecessor key does not exist");
    const predecessorUpdate = await this.#revokedKeyUpdate(predecessor, now);
    const keyJson = await trustedDeviceKeyJson(key);
    if (
      event.type !== "rotate-key"
      || event.challengeId !== challenge.challengeId
      || event.deviceId !== transition.deviceId
      || event.keyId !== key.keyId
      || event.predecessorKeyId !== transition.predecessorKeyId
      || challenge.deviceId !== transition.deviceId
      || challenge.keyId !== key.keyId
      || key.deviceId !== transition.deviceId
      || key.predecessorKeyId !== transition.predecessorKeyId
    ) {
      throw new DeviceTrustConflictError("rotation transition records do not agree");
    }
    const outcome = this.#transaction((): "inserted" | "replayed" => {
      if (this.#eventReplay(event)) return "replayed";
      this.#assertChallengeUsable(challenge, now);
      this.#activeActor(event);
      const current = this.#keyRow(predecessor.keyId);
      const device = this.#deviceRow(transition.deviceId);
      if (
        current?.status !== "active"
        || current.device_id !== transition.deviceId
        || current.record_json !== predecessorUpdate.before
        || device?.status !== "active"
      ) {
        throw new DeviceTrustConflictError("rotation predecessor/device is no longer active");
      }
      if (
        event.actor.mode !== "trusted-device"
        || event.actor.keyId !== predecessor.keyId
        || challenge.authorizedByKeyId !== predecessor.keyId
        || challenge.authorizedByDeviceId !== transition.deviceId
      ) {
        throw new DeviceTrustAuthorizationError("rotation must be authorized by the active predecessor key");
      }
      if (this.#keyRow(key.keyId) !== undefined) {
        throw new DeviceTrustConflictError("rotation key already exists and cannot be reactivated/rebound");
      }
      this.#db.prepare(`
        INSERT INTO trusted_device_keys(
          key_id, device_id, public_jwk_json, activated_at, status,
          revoked_at, predecessor_key_id, record_json
        ) VALUES (?, ?, ?, ?, 'active', NULL, ?, ?)
      `).run(
        key.keyId,
        key.deviceId,
        JSON.stringify(key.publicKeyJwk),
        key.activatedAt,
        key.predecessorKeyId ?? null,
        keyJson,
      );
      this.#updateActiveKey(
        predecessor.keyId,
        predecessorUpdate.before,
        predecessorUpdate.after,
        now,
        "predecessor key",
      );
      this.#insertEvent(event);
      this.#consumeChallenge(challenge.challengeId, now);
      return "inserted";
    });
    const materialized = await this.#materializedDeviceAndKey(transition.deviceId, key.keyId, "rotation");
    return { outcome, event, ...materialized };
  }

  async revokeKey(transition: RevokeKeyTransition): Promise<DeviceTrustMutationResult> {
    const event = normalizeDeviceTrustEvent(transition.event) as RevokeKeyTransition["event"];
    const now = canonicalTimestamp(transition.now, "key revocation now");
    const target = await this.key(transition.keyId);
    if (target === undefined) throw new DeviceTrustConflictError("target key does not exist");
    const targetUpdate = await this.#revokedKeyUpdate(target, now);
    const outcome = this.#transaction((): "inserted" | "replayed" => {
      if (this.#eventReplay(event)) return "replayed";
      const actor = this.#activeActor(event);
      const device = this.#deviceRow(target.deviceId);
      const current = this.#keyRow(target.keyId);
      if (
        device === undefined
        || current?.status !== "active"
        || current.record_json !== targetUpdate.before
        || actor.device.principal_json !== device.principal_json
        || event.deviceId !== target.deviceId
        || event.keyId !== target.keyId
      ) {
        throw new DeviceTrustAuthorizationError("key revocation target is not active for the actor principal");
      }
      this.#updateActiveKey(
        target.keyId,
        targetUpdate.before,
        targetUpdate.after,
        now,
        "target key",
      );
      this.#insertEvent(event);
      return "inserted";
    });
    const device = await this.device(target.deviceId);
    const key = await this.key(target.keyId);
    if (device === undefined || key === undefined) throw new CorruptDeviceTrustDatabaseError("revoked key state is missing");
    return { outcome, event, device, key };
  }

  async revokeDevice(transition: RevokeDeviceTransition): Promise<DeviceTrustMutationResult> {
    const event = normalizeDeviceTrustEvent(transition.event) as RevokeDeviceTransition["event"];
    const now = canonicalTimestamp(transition.now, "device revocation now");
    const target = await this.device(transition.deviceId);
    if (target === undefined) throw new DeviceTrustConflictError("target device does not exist");
    const targetJson = trustedDeviceJson(target);
    const revokedDevice = normalizeTrustedDevice({ ...target, status: "revoked", revokedAt: now });
    const revokedDeviceJson = trustedDeviceJson(revokedDevice);
    const keyRows = this.#db.prepare(`
      SELECT key_id, device_id, public_jwk_json, activated_at, status,
             revoked_at, predecessor_key_id, record_json
      FROM trusted_device_keys
      WHERE device_id = ? AND status = 'active'
      ORDER BY key_id
    `).all(target.deviceId) as unknown as KeyRow[];
    const activeKeys = await Promise.all(keyRows.map((row) => this.#validatedKeyRow(row)));
    const keyUpdates = await Promise.all(activeKeys.map(async (key) => ({
      key,
      ...await this.#revokedKeyUpdate(key, now),
    })));

    const outcome = this.#transaction((): "inserted" | "replayed" => {
      if (this.#eventReplay(event)) return "replayed";
      const actor = this.#activeActor(event);
      const currentDevice = this.#deviceRow(target.deviceId);
      if (
        currentDevice?.status !== "active"
        || currentDevice.record_json !== targetJson
        || actor.device.principal_json !== currentDevice.principal_json
        || event.deviceId !== target.deviceId
      ) {
        throw new DeviceTrustAuthorizationError("device revocation target is not active for the actor principal");
      }
      for (const update of keyUpdates) {
        this.#updateActiveKey(
          update.key.keyId,
          update.before,
          update.after,
          now,
          `device key ${update.key.keyId}`,
        );
      }
      const updatedDevice = this.#db.prepare(`
        UPDATE trusted_devices
        SET status = 'revoked', revoked_at = ?, record_json = ?
        WHERE device_id = ? AND status = 'active' AND record_json = ?
      `).run(now, revokedDeviceJson, target.deviceId, targetJson);
      if (changes(updatedDevice.changes) !== 1) {
        throw new DeviceTrustConflictError("target device changed during revocation");
      }
      this.#insertEvent(event);
      return "inserted";
    });
    const device = await this.device(target.deviceId);
    if (device === undefined) throw new CorruptDeviceTrustDatabaseError("revoked device state is missing");
    return { outcome, event, device };
  }

  async setRecoveryCredential(
    transition: SetRecoveryCredentialTransition,
  ): Promise<RecoveryCredentialMutationResult> {
    const event = normalizeDeviceTrustEvent(transition.event) as SetRecoveryCredentialTransition["event"];
    const credential = await normalizeTrustedRecoveryCredential(transition.credential);
    const now = canonicalTimestamp(transition.now, "recovery credential now");
    const credentialJson = await trustedRecoveryCredentialJson(credential);
    const previous = transition.previousRecoveryKeyId === undefined
      ? undefined
      : await this.recoveryCredential(transition.previousRecoveryKeyId);
    if (transition.previousRecoveryKeyId !== undefined && previous === undefined) {
      throw new DeviceTrustConflictError("previous recovery credential does not exist");
    }
    const previousUpdate = previous === undefined
      ? undefined
      : await this.#retiredRecoveryUpdate(previous, now);
    if (
      event.type !== "set-recovery-credential"
      || event.actor.mode !== "trusted-device"
      || event.recoveryKeyId !== credential.keyId
      || event.recoveryGeneration !== credential.generation
      || event.deviceId !== event.actor.deviceId
      || credential.status !== "active"
      || JSON.stringify(event.principal) !== JSON.stringify(credential.principal)
      || (previous === undefined
        ? credential.generation !== 1 || credential.predecessorKeyId !== undefined
        : credential.generation !== previous.generation + 1
          || credential.predecessorKeyId !== previous.keyId)
    ) {
      throw new DeviceTrustConflictError("recovery credential transition records do not agree");
    }

    const outcome = this.#transaction((): "inserted" | "replayed" => {
      if (this.#eventReplay(event)) return "replayed";
      const actor = this.#activeActor(event);
      if (actor.device.principal_json !== JSON.stringify(credential.principal)) {
        throw new DeviceTrustAuthorizationError("recovery credential principal does not match actor");
      }
      if (this.#keyRow(credential.keyId) !== undefined) {
        throw new DeviceTrustConflictError("recovery key material cannot reuse a device key");
      }
      if (this.#recoveryCredentialRow(credential.keyId) !== undefined) {
        throw new DeviceTrustConflictError("recovery credential key has already been used");
      }
      const active = this.#db.prepare(`
        SELECT key_id, principal_json, public_jwk_json, generation, activated_at,
               status, retired_at, predecessor_key_id, record_json
        FROM trusted_recovery_credentials
        WHERE principal_json = ? AND status = 'active'
      `).get(JSON.stringify(credential.principal)) as RecoveryCredentialRow | undefined;
      if (previous === undefined) {
        if (active !== undefined) {
          throw new DeviceTrustConflictError("principal already has an active recovery credential");
        }
      } else {
        if (
          active?.key_id !== previous.keyId
          || active.record_json !== previousUpdate?.before
          || active.status !== "active"
        ) {
          throw new DeviceTrustConflictError("previous recovery credential is no longer active");
        }
        this.#updateActiveRecoveryCredential(
          previous.keyId,
          previousUpdate.before,
          previousUpdate.after,
          now,
        );
      }
      this.#insertRecoveryCredential(credential, credentialJson);
      this.#insertEvent(event);
      return "inserted";
    });
    const materialized = await this.recoveryCredential(credential.keyId);
    if (materialized === undefined) {
      throw new CorruptDeviceTrustDatabaseError("materialized recovery credential is missing");
    }
    return { outcome, event, credential: materialized };
  }

  async recoverTrustSet(
    transition: RecoverTrustSetTransition,
  ): Promise<RecoveryTrustSetMutationResult> {
    const event = normalizeDeviceTrustEvent(transition.event) as RecoverTrustSetTransition["event"];
    const challenge = await validateDeviceRecoveryChallengeKeyIds(transition.challenge);
    const challengeJson = await deviceRecoveryChallengeJson(challenge);
    const device = normalizeTrustedDevice(transition.device);
    const key = await normalizeTrustedDeviceKey(transition.key);
    const recoveryCredential = await normalizeTrustedRecoveryCredential(
      transition.recoveryCredential,
    );
    const now = canonicalTimestamp(transition.now, "trust recovery now");
    const keyJson = await trustedDeviceKeyJson(key);
    const recoveryJson = await trustedRecoveryCredentialJson(recoveryCredential);

    if (
      event.type !== "recover-trust-set"
      || event.actor.mode !== "recovery-credential"
      || event.challengeId !== challenge.challengeId
      || event.deviceId !== device.deviceId
      || event.keyId !== key.keyId
      || key.deviceId !== device.deviceId
      || challenge.deviceId !== device.deviceId
      || challenge.keyId !== key.keyId
      || event.recoveryKeyId !== transition.previousRecoveryKeyId
      || event.recoveryKeyId !== challenge.recoveryKeyId
      || event.recoveryGeneration !== challenge.recoveryGeneration
      || event.nextRecoveryKeyId !== recoveryCredential.keyId
      || event.nextRecoveryKeyId !== challenge.nextRecoveryKeyId
      || event.nextRecoveryGeneration !== recoveryCredential.generation
      || event.nextRecoveryGeneration !== challenge.nextRecoveryGeneration
      || recoveryCredential.predecessorKeyId !== transition.previousRecoveryKeyId
      || recoveryCredential.status !== "active"
      || JSON.stringify(event.principal) !== JSON.stringify(device.principal)
      || JSON.stringify(challenge.principal) !== JSON.stringify(device.principal)
      || JSON.stringify(recoveryCredential.principal) !== JSON.stringify(device.principal)
    ) {
      throw new DeviceTrustConflictError("trust recovery transition records do not agree");
    }

    if (this.#eventReplay(event)) {
      const [replayedDevice, replayedKey, replayedRecovery] = await Promise.all([
        this.device(device.deviceId),
        this.key(key.keyId),
        this.recoveryCredential(recoveryCredential.keyId),
      ]);
      if (
        replayedDevice === undefined
        || replayedKey === undefined
        || replayedRecovery === undefined
      ) {
        throw new CorruptDeviceTrustDatabaseError(
          "replayed trust recovery event has missing materialized state",
        );
      }
      return {
        outcome: "replayed",
        event,
        device: replayedDevice,
        key: replayedKey,
        recoveryCredential: replayedRecovery,
      };
    }

    const previous = await this.recoveryCredential(transition.previousRecoveryKeyId);
    if (previous === undefined) {
      throw new DeviceTrustConflictError("recovery authorizing credential does not exist");
    }
    if (
      previous.status !== "active"
      || previous.generation !== challenge.recoveryGeneration
      || previous.keyId !== challenge.recoveryKeyId
      || JSON.stringify(previous.principal) !== JSON.stringify(challenge.principal)
      || JSON.stringify(previous.publicKeyJwk) !== JSON.stringify(challenge.recoveryPublicKeyJwk)
      || event.actor.keyId !== previous.keyId
      || event.actor.generation !== previous.generation
    ) {
      throw new DeviceTrustAuthorizationError("recovery authorizer no longer matches challenge state");
    }
    const previousUpdate = await this.#retiredRecoveryUpdate(previous, now);
    const principalJson = JSON.stringify(device.principal);

    const deviceRows = this.#db.prepare(`
      SELECT device_id, principal_json, display_name, enrolled_at, status, revoked_at, record_json
      FROM trusted_devices
      WHERE principal_json = ? AND status = 'active'
      ORDER BY device_id
    `).all(principalJson) as unknown as DeviceRow[];
    const activeDevices = await Promise.all(
      deviceRows.map((row) => this.#validatedDeviceRow(row)),
    );
    const deviceUpdates = activeDevices.map((current) => ({
      current,
      before: trustedDeviceJson(current),
      after: trustedDeviceJson(normalizeTrustedDevice({
        ...current,
        status: "revoked",
        revokedAt: now,
      })),
    }));

    const keyRows = this.#db.prepare(`
      SELECT k.key_id, k.device_id, k.public_jwk_json, k.activated_at, k.status,
             k.revoked_at, k.predecessor_key_id, k.record_json
      FROM trusted_device_keys k
      JOIN trusted_devices d ON d.device_id = k.device_id
      WHERE d.principal_json = ? AND k.status = 'active'
      ORDER BY k.key_id
    `).all(principalJson) as unknown as KeyRow[];
    const activeKeys = await Promise.all(keyRows.map((row) => this.#validatedKeyRow(row)));
    const keyUpdates = await Promise.all(activeKeys.map(async (current) => ({
      current,
      ...await this.#revokedKeyUpdate(current, now),
    })));
    const expectedDeviceIds = deviceUpdates.map((update) => update.current.deviceId);
    const expectedKeyIds = keyUpdates.map((update) => update.current.keyId);

    const outcome = this.#transaction((): "inserted" | "replayed" => {
      if (this.#eventReplay(event)) return "replayed";
      this.#assertRecoveryChallengeUsable(challenge, challengeJson, now);

      const currentRecovery = this.#recoveryCredentialRow(previous.keyId);
      if (
        currentRecovery?.status !== "active"
        || currentRecovery.record_json !== previousUpdate.before
      ) {
        throw new DeviceTrustAuthorizationError("recovery credential is no longer active");
      }
      if (
        this.#deviceRow(device.deviceId) !== undefined
        || this.#keyRow(key.keyId) !== undefined
        || this.#recoveryCredentialRow(key.keyId) !== undefined
        || this.#keyRow(recoveryCredential.keyId) !== undefined
        || this.#recoveryCredentialRow(recoveryCredential.keyId) !== undefined
      ) {
        throw new DeviceTrustConflictError("recovery replacement identities are no longer fresh");
      }

      const currentDeviceIds = (this.#db.prepare(`
        SELECT device_id FROM trusted_devices
        WHERE principal_json = ? AND status = 'active'
        ORDER BY device_id
      `).all(principalJson) as unknown as { readonly device_id: string }[])
        .map((row) => row.device_id);
      const currentKeyIds = (this.#db.prepare(`
        SELECT k.key_id
        FROM trusted_device_keys k
        JOIN trusted_devices d ON d.device_id = k.device_id
        WHERE d.principal_json = ? AND k.status = 'active'
        ORDER BY k.key_id
      `).all(principalJson) as unknown as { readonly key_id: string }[])
        .map((row) => row.key_id);
      if (
        JSON.stringify(currentDeviceIds) !== JSON.stringify(expectedDeviceIds)
        || JSON.stringify(currentKeyIds) !== JSON.stringify(expectedKeyIds)
      ) {
        throw new DeviceTrustConflictError("principal trust set changed during recovery");
      }

      for (const update of keyUpdates) {
        const current = this.#keyRow(update.current.keyId);
        if (current?.record_json !== update.before || current.status !== "active") {
          throw new DeviceTrustConflictError(
            `device key ${update.current.keyId} changed during recovery`,
          );
        }
        this.#updateActiveKey(
          update.current.keyId,
          update.before,
          update.after,
          now,
          `recovery device key ${update.current.keyId}`,
        );
      }
      for (const update of deviceUpdates) {
        const updated = this.#db.prepare(`
          UPDATE trusted_devices
          SET status = 'revoked', revoked_at = ?, record_json = ?
          WHERE device_id = ? AND status = 'active' AND record_json = ?
        `).run(now, update.after, update.current.deviceId, update.before);
        if (changes(updated.changes) !== 1) {
          throw new DeviceTrustConflictError(
            `device ${update.current.deviceId} changed during recovery`,
          );
        }
      }

      this.#updateActiveRecoveryCredential(
        previous.keyId,
        previousUpdate.before,
        previousUpdate.after,
        now,
      );
      this.#insertDevice(device);
      this.#db.prepare(`
        INSERT INTO trusted_device_keys(
          key_id, device_id, public_jwk_json, activated_at, status,
          revoked_at, predecessor_key_id, record_json
        ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, ?)
      `).run(
        key.keyId,
        key.deviceId,
        JSON.stringify(key.publicKeyJwk),
        key.activatedAt,
        keyJson,
      );
      this.#insertRecoveryCredential(recoveryCredential, recoveryJson);
      this.#insertEvent(event);
      this.#consumeRecoveryChallenge(challenge.challengeId, now);
      return "inserted";
    });

    const [materializedDevice, materializedKey, materializedRecovery] = await Promise.all([
      this.device(device.deviceId),
      this.key(key.keyId),
      this.recoveryCredential(recoveryCredential.keyId),
    ]);
    if (
      materializedDevice === undefined
      || materializedKey === undefined
      || materializedRecovery === undefined
    ) {
      throw new CorruptDeviceTrustDatabaseError("materialized trust recovery state is missing");
    }
    return {
      outcome,
      event,
      device: materializedDevice,
      key: materializedKey,
      recoveryCredential: materializedRecovery,
    };
  }

  consume(input: ReplicationSignatureReplayInput): boolean {
    if (!Number.isSafeInteger(input.expiresAt) || !Number.isSafeInteger(input.now)) {
      throw new TypeError("replication replay times must be integer epoch seconds");
    }
    if (input.keyId.length === 0 || input.nonce.length === 0) throw new TypeError("replay keyId/nonce must not be empty");
    return this.#transaction(() => {
      this.#db.prepare("DELETE FROM replication_signature_replays WHERE expires_at < ?").run(input.now);
      const active = this.#db.prepare(`
        SELECT 1 AS present
        FROM trusted_device_keys k
        JOIN trusted_devices d ON d.device_id = k.device_id
        WHERE k.key_id = ? AND k.status = 'active' AND d.status = 'active'
      `).get(input.keyId) as { readonly present: number } | undefined;
      if (active === undefined || input.expiresAt < input.now) return false;
      const existing = this.#db.prepare(`
        SELECT 1 AS present
        FROM replication_signature_replays
        WHERE key_id = ? AND nonce = ?
      `).get(input.keyId, input.nonce) as { readonly present: number } | undefined;
      if (existing !== undefined) return false;
      this.#db.prepare(`
        INSERT INTO replication_signature_replays(key_id, nonce, expires_at)
        VALUES (?, ?, ?)
      `).run(input.keyId, input.nonce, input.expiresAt);
      return true;
    });
  }

  async pruneExpired(now: string): Promise<number> {
    const timestamp = canonicalTimestamp(now, "prune now");
    const epochSeconds = Math.floor(Date.parse(timestamp) / 1_000);
    return this.#transaction(() => {
      const challenges = this.#db.prepare(`
        DELETE FROM device_trust_challenges
        WHERE expires_at < ?
      `).run(timestamp);
      const recoveryChallenges = this.#db.prepare(`
        DELETE FROM device_recovery_challenges
        WHERE expires_at < ? AND consumed_at IS NULL
      `).run(timestamp);
      const replays = this.#db.prepare(`
        DELETE FROM replication_signature_replays
        WHERE expires_at < ?
      `).run(epochSeconds);
      return changes(challenges.changes)
        + changes(recoveryChallenges.changes)
        + changes(replays.changes);
    });
  }

  close(): void {
    this.#db.close();
  }
}
