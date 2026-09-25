import { normalizeAccessPrincipal, type AccessPrincipal } from "@ssrl/access";
import { canonicalJson } from "@ssrl/core";
import {
  ed25519JwkThumbprintUri,
  normalizeEd25519PublicJwk,
  normalizeTrustedEncryptionKeyBinding,
  type ActiveDeviceAuthorization,
  type DeviceTrustManager,
  type DeviceTrustRepository,
  type Ed25519PublicJwk,
  type TrustedEncryptionKeyBinding,
} from "@ssrl/device-trust";
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesCopy,
  canonicalBytes,
  createEpochKeyGrant,
  epochKeyGrantJson,
  generateVaultEpoch,
  normalizeEpochKeyGrant,
  normalizeVaultEpochId,
  openEpochKeyGrant,
  x25519JwkThumbprintUri,
  x25519PublicFromPrivate,
  type HpkeEpochKeyGrant,
  type VaultEpochId,
  type VaultEpochSecret,
  type X25519PrivateJwk,
} from "@ssrl/e2e";

export const VAULT_KEYRING_TRANSITION_SCHEMA = "ssrl-vault-keyring-transition-v1" as const;
export const VAULT_KEYRING_EVENT_SCHEMA = "ssrl-vault-keyring-event-v1" as const;

export type VaultEpochReason = "bootstrap" | "recipient-set-change" | "manual";
export type VaultKeyringOperation = "bootstrap-epoch" | "rotate-epoch" | "extend-historical-grants";

export interface VaultEpochRecord {
  readonly epochId: VaultEpochId;
  readonly principal: AccessPrincipal;
  readonly predecessorEpochId?: VaultEpochId;
  readonly createdAt: string;
  readonly reason: VaultEpochReason;
  readonly createdByDeviceId: string;
  readonly createdBySigningKeyId: string;
}

export interface VaultKeyringTransition {
  readonly schema: typeof VAULT_KEYRING_TRANSITION_SCHEMA;
  readonly eventId: string;
  readonly operation: VaultKeyringOperation;
  readonly principal: AccessPrincipal;
  readonly epoch: VaultEpochRecord;
  readonly activeRecipients: readonly TrustedEncryptionKeyBinding[];
  readonly grantsAdded: readonly HpkeEpochKeyGrant[];
  readonly resultingRecipientKeyIds: readonly string[];
  readonly issuerDeviceId: string;
  readonly issuerSigningKeyId: string;
  readonly issuerPublicKeyJwk: Ed25519PublicJwk;
  readonly audience: string;
  readonly createdAt: string;
}

export interface AuthorizedVaultKeyringEvent {
  readonly schema: typeof VAULT_KEYRING_EVENT_SCHEMA;
  readonly transition: VaultKeyringTransition;
  readonly signature: string;
}

export interface VaultKeyringMutationResult {
  readonly outcome: "inserted" | "replayed";
  readonly event: AuthorizedVaultKeyringEvent;
  readonly epoch: VaultEpochRecord;
  readonly grants: readonly HpkeEpochKeyGrant[];
  /** Present only for a newly generated epoch. Never persisted by the repository. */
  readonly epochSecret?: VaultEpochSecret;
}

export interface VaultKeyringRepository {
  event(eventId: string): AuthorizedVaultKeyringEvent | undefined | Promise<AuthorizedVaultKeyringEvent | undefined>;
  epoch(epochId: VaultEpochId): VaultEpochRecord | undefined | Promise<VaultEpochRecord | undefined>;
  activeEpoch(principal: AccessPrincipal): VaultEpochRecord | undefined | Promise<VaultEpochRecord | undefined>;
  epochsForPrincipal(principal: AccessPrincipal): readonly VaultEpochRecord[] | Promise<readonly VaultEpochRecord[]>;
  grantsForEpoch(epochId: VaultEpochId): readonly HpkeEpochKeyGrant[] | Promise<readonly HpkeEpochKeyGrant[]>;
  grant(
    epochId: VaultEpochId,
    recipientKeyId: string,
  ): HpkeEpochKeyGrant | undefined | Promise<HpkeEpochKeyGrant | undefined>;
  /**
   * Persists a structurally and cryptographically valid signed event.
   * This is not a network trust-admission boundary: the manager must authorize
   * the issuer against device trust before creating a new transition.
   */
  commit(event: AuthorizedVaultKeyringEvent): VaultKeyringCommitResult | Promise<VaultKeyringCommitResult>;
}

export interface VaultKeyringCommitResult {
  readonly outcome: "inserted" | "replayed";
  readonly event: AuthorizedVaultKeyringEvent;
  readonly epoch: VaultEpochRecord;
  readonly grants: readonly HpkeEpochKeyGrant[];
}

export interface VaultKeyringManagerOptions {
  readonly repository: VaultKeyringRepository;
  readonly deviceTrustManager: Pick<DeviceTrustManager, "activeAuthorization">;
  readonly deviceTrustRepository: Pick<DeviceTrustRepository, "activeEncryptionRecipients">;
  readonly now?: () => number;
}

export interface VaultEpochMutationInput {
  readonly eventId: string;
  readonly authorizingKeyId: string;
  readonly authorizingPrivateKey: CryptoKey;
  readonly audience: string;
}

export interface RotateVaultEpochInput extends VaultEpochMutationInput {
  readonly reason: Exclude<VaultEpochReason, "bootstrap">;
}

export interface ExtendHistoricalGrantsInput extends VaultEpochMutationInput {
  readonly epochId: VaultEpochId;
  /** Local secret input only. It is never embedded in the transition or repository. */
  readonly sourceRecipientPrivateKeyJwk: X25519PrivateJwk;
}

export class VaultKeyringError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class VaultKeyringConflictError extends VaultKeyringError {}
export class VaultKeyringAuthorizationError extends VaultKeyringError {}
export class VaultKeyringProofError extends VaultKeyringError {}
export class CorruptVaultKeyringError extends VaultKeyringError {}

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${label} must not be empty`);
  return normalized;
}

function canonicalTimestamp(value: string, label: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function nowIso(now: () => number): string {
  const millis = now();
  if (!Number.isFinite(millis)) throw new TypeError("vault keyring clock must return epoch milliseconds");
  return new Date(millis).toISOString();
}

function samePrincipal(left: AccessPrincipal, right: AccessPrincipal): boolean {
  return canonicalJson(normalizeAccessPrincipal(left)) === canonicalJson(normalizeAccessPrincipal(right));
}

function operation(value: VaultKeyringOperation): VaultKeyringOperation {
  if (
    value !== "bootstrap-epoch"
    && value !== "rotate-epoch"
    && value !== "extend-historical-grants"
  ) {
    throw new TypeError("vault keyring operation is invalid");
  }
  return value;
}

function epochReason(value: VaultEpochReason): VaultEpochReason {
  if (value !== "bootstrap" && value !== "recipient-set-change" && value !== "manual") {
    throw new TypeError("vault epoch reason is invalid");
  }
  return value;
}

export function normalizeVaultEpochRecord(value: VaultEpochRecord): VaultEpochRecord {
  const principal = normalizeAccessPrincipal(value.principal);
  const epochId = normalizeVaultEpochId(value.epochId);
  const predecessorEpochId = value.predecessorEpochId === undefined
    ? undefined
    : normalizeVaultEpochId(value.predecessorEpochId);
  if (predecessorEpochId === epochId) throw new TypeError("vault epoch cannot be its own predecessor");
  return {
    epochId,
    principal,
    ...(predecessorEpochId === undefined ? {} : { predecessorEpochId }),
    createdAt: canonicalTimestamp(value.createdAt, "vault epoch createdAt"),
    reason: epochReason(value.reason),
    createdByDeviceId: requiredString(value.createdByDeviceId, "vault epoch creator deviceId"),
    createdBySigningKeyId: requiredString(value.createdBySigningKeyId, "vault epoch creator signingKeyId"),
  };
}

function recipientOrder(
  left: TrustedEncryptionKeyBinding,
  right: TrustedEncryptionKeyBinding,
): number {
  return left.encryptionKeyId.localeCompare(right.encryptionKeyId)
    || left.subjectKind.localeCompare(right.subjectKind)
    || left.subjectKeyId.localeCompare(right.subjectKeyId);
}

export async function normalizeVaultRecipientSnapshot(
  values: readonly TrustedEncryptionKeyBinding[],
): Promise<TrustedEncryptionKeyBinding[]> {
  const normalized = await Promise.all(values.map(normalizeTrustedEncryptionKeyBinding));
  const ids = new Set<string>();
  for (const binding of normalized) {
    if (ids.has(binding.encryptionKeyId)) {
      throw new TypeError(`duplicate vault recipient encryptionKeyId ${binding.encryptionKeyId}`);
    }
    ids.add(binding.encryptionKeyId);
  }
  return normalized.toSorted(recipientOrder);
}

function sortedUniqueIds(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => requiredString(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} values must be unique`);
  }
  return normalized.toSorted((left, right) => left.localeCompare(right));
}

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function grantsOrder(left: HpkeEpochKeyGrant, right: HpkeEpochKeyGrant): number {
  return left.recipientKeyId.localeCompare(right.recipientKeyId);
}


export function orderedVaultEpochsForPrincipal(
  epochs: readonly VaultEpochRecord[],
  principal: AccessPrincipal,
): VaultEpochRecord[] {
  const normalized = normalizeAccessPrincipal(principal);
  return epochs
    .filter((epoch) => samePrincipal(epoch.principal, normalized))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.epochId.localeCompare(right.epochId));
}

export function deriveActiveVaultEpoch(
  epochs: readonly VaultEpochRecord[],
  principal: AccessPrincipal,
): VaultEpochRecord | undefined {
  const matching = orderedVaultEpochsForPrincipal(epochs, principal);
  if (matching.length === 0) return undefined;
  const predecessors = new Set(
    matching.flatMap((epoch) => epoch.predecessorEpochId === undefined ? [] : [epoch.predecessorEpochId]),
  );
  const heads = matching.filter((epoch) => !predecessors.has(epoch.epochId));
  if (heads.length !== 1) {
    throw new CorruptVaultKeyringError(`vault principal has ${heads.length} active epoch heads`);
  }
  return heads[0];
}

export function orderedVaultGrantsForEpoch(
  grants: readonly HpkeEpochKeyGrant[],
  epochId: VaultEpochId,
): HpkeEpochKeyGrant[] {
  const normalizedEpochId = normalizeVaultEpochId(epochId);
  return grants
    .filter((grant) => grant.epochId === normalizedEpochId)
    .toSorted(grantsOrder);
}


export function vaultGrantsForRecipientInventory(
  grants: readonly HpkeEpochKeyGrant[],
  recipientKeyIds: readonly string[],
): HpkeEpochKeyGrant[] {
  const normalized = grants.map(normalizeEpochKeyGrant);
  const byRecipient = new Map<string, HpkeEpochKeyGrant>();
  for (const grant of normalized) {
    if (byRecipient.has(grant.recipientKeyId)) {
      throw new CorruptVaultKeyringError(
        `duplicate persisted vault grant recipient ${grant.recipientKeyId}`,
      );
    }
    byRecipient.set(grant.recipientKeyId, grant);
  }
  return recipientKeyIds.map((recipientKeyId) => {
    const grant = byRecipient.get(recipientKeyId);
    if (grant === undefined) {
      throw new CorruptVaultKeyringError(
        `persisted vault grant inventory is missing recipient ${recipientKeyId}`,
      );
    }
    return grant;
  });
}

function normalizeGrantSet(
  values: readonly HpkeEpochKeyGrant[],
  epochId: VaultEpochId,
): HpkeEpochKeyGrant[] {
  const normalized = values.map(normalizeEpochKeyGrant).toSorted(grantsOrder);
  const ids = new Set<string>();
  for (const grant of normalized) {
    if (grant.epochId !== epochId) throw new TypeError("vault grant epochId disagrees with transition epoch");
    if (ids.has(grant.recipientKeyId)) {
      throw new TypeError(`duplicate vault grant recipient ${grant.recipientKeyId}`);
    }
    ids.add(grant.recipientKeyId);
  }
  return normalized;
}

export async function normalizeVaultKeyringTransition(
  value: VaultKeyringTransition,
): Promise<VaultKeyringTransition> {
  if (value.schema !== VAULT_KEYRING_TRANSITION_SCHEMA) {
    throw new TypeError("vault keyring transition schema is invalid");
  }
  const normalizedOperation = operation(value.operation);
  const principal = normalizeAccessPrincipal(value.principal);
  const epoch = normalizeVaultEpochRecord(value.epoch);
  if (!samePrincipal(principal, epoch.principal)) {
    throw new TypeError("vault keyring transition principal disagrees with epoch principal");
  }
  if (normalizedOperation === "bootstrap-epoch") {
    if (epoch.predecessorEpochId !== undefined || epoch.reason !== "bootstrap") {
      throw new TypeError("bootstrap epoch must have no predecessor and reason=bootstrap");
    }
  } else if (normalizedOperation === "rotate-epoch") {
    if (epoch.predecessorEpochId === undefined || epoch.reason === "bootstrap") {
      throw new TypeError("rotated epoch requires predecessor and non-bootstrap reason");
    }
  }
  const issuerPublicKeyJwk = normalizeEd25519PublicJwk(value.issuerPublicKeyJwk);
  const issuerSigningKeyId = requiredString(value.issuerSigningKeyId, "vault issuer signingKeyId");
  if (await ed25519JwkThumbprintUri(issuerPublicKeyJwk) !== issuerSigningKeyId) {
    throw new TypeError("vault issuer signingKeyId does not match public JWK thumbprint");
  }
  const activeRecipients = await normalizeVaultRecipientSnapshot(value.activeRecipients);
  for (const recipient of activeRecipients) {
    if (!samePrincipal(recipient.principal, principal)) {
      throw new TypeError("vault recipient principal disagrees with transition principal");
    }
  }
  const grantsAdded = normalizeGrantSet(value.grantsAdded, epoch.epochId);
  const activeRecipientIds = activeRecipients.map((recipient) => recipient.encryptionKeyId);
  const addedIds = grantsAdded.map((grant) => grant.recipientKeyId);
  if (addedIds.some((id) => !activeRecipientIds.includes(id))) {
    throw new TypeError("vault grant recipient is not present in the signed active recipient snapshot");
  }
  if (
    (normalizedOperation === "bootstrap-epoch" || normalizedOperation === "rotate-epoch")
    && !idsEqual(addedIds, activeRecipientIds)
  ) {
    throw new TypeError("new vault epoch must grant exactly the signed active recipient snapshot");
  }
  const resultingRecipientKeyIds = sortedUniqueIds(
    value.resultingRecipientKeyIds,
    "vault resulting recipient key id",
  );
  if (addedIds.some((id) => !resultingRecipientKeyIds.includes(id))) {
    throw new TypeError("vault resulting recipient inventory omits a newly added grant");
  }
  if (activeRecipientIds.some((id) => !resultingRecipientKeyIds.includes(id))) {
    throw new TypeError("vault resulting recipient inventory omits an active trusted recipient");
  }
  const issuerDeviceId = requiredString(value.issuerDeviceId, "vault issuer deviceId");
  if (
    epoch.createdBySigningKeyId !== issuerSigningKeyId
    || epoch.createdByDeviceId !== issuerDeviceId
  ) {
    if (normalizedOperation !== "extend-historical-grants") {
      throw new TypeError("new vault epoch creator must match transition issuer");
    }
  }
  return {
    schema: VAULT_KEYRING_TRANSITION_SCHEMA,
    eventId: requiredString(value.eventId, "vault keyring eventId"),
    operation: normalizedOperation,
    principal,
    epoch,
    activeRecipients,
    grantsAdded,
    resultingRecipientKeyIds,
    issuerDeviceId,
    issuerSigningKeyId,
    issuerPublicKeyJwk,
    audience: requiredString(value.audience, "vault keyring audience"),
    createdAt: canonicalTimestamp(value.createdAt, "vault keyring createdAt"),
  };
}

export async function vaultKeyringTransitionJson(value: VaultKeyringTransition): Promise<string> {
  return canonicalJson(await normalizeVaultKeyringTransition(value));
}

export async function vaultKeyringTransitionBytes(value: VaultKeyringTransition): Promise<Uint8Array> {
  return canonicalBytes(JSON.parse(await vaultKeyringTransitionJson(value)) as unknown);
}

async function signTransition(
  transition: VaultKeyringTransition,
  privateKey: CryptoKey,
): Promise<string> {
  if (
    privateKey.type !== "private"
    || privateKey.algorithm.name !== "Ed25519"
    || !privateKey.usages.includes("sign")
  ) {
    throw new TypeError("vault keyring issuer key must be an Ed25519 private CryptoKey");
  }
  const signature = await globalThis.crypto.subtle.sign(
    "Ed25519",
    privateKey,
    bytesCopy(await vaultKeyringTransitionBytes(transition)),
  );
  return base64UrlEncode(signature);
}

/**
 * Verifies the event-carried Ed25519 key/signature and transition integrity.
 * It does not establish that the issuer key is trusted for the principal; that
 * authorization is supplied by the device-trust layer.
 */
export async function verifyAuthorizedVaultKeyringEvent(
  value: AuthorizedVaultKeyringEvent,
): Promise<boolean> {
  try {
    if (value.schema !== VAULT_KEYRING_EVENT_SCHEMA) return false;
    const transition = await normalizeVaultKeyringTransition(value.transition);
    const signature = base64UrlDecode(value.signature, "vault keyring signature", { exactBytes: 64 });
    const publicKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      transition.issuerPublicKeyJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return globalThis.crypto.subtle.verify(
      "Ed25519",
      publicKey,
      bytesCopy(signature),
      bytesCopy(await vaultKeyringTransitionBytes(transition)),
    );
  } catch {
    return false;
  }
}

export async function normalizeAuthorizedVaultKeyringEvent(
  value: AuthorizedVaultKeyringEvent,
): Promise<AuthorizedVaultKeyringEvent> {
  if (value.schema !== VAULT_KEYRING_EVENT_SCHEMA) {
    throw new TypeError("vault keyring event schema is invalid");
  }
  const transition = await normalizeVaultKeyringTransition(value.transition);
  base64UrlDecode(value.signature, "vault keyring signature", { exactBytes: 64 });
  const event = { schema: VAULT_KEYRING_EVENT_SCHEMA, transition, signature: value.signature } as const;
  if (!(await verifyAuthorizedVaultKeyringEvent(event))) {
    throw new VaultKeyringProofError("vault keyring event issuer signature is invalid");
  }
  return event;
}

export async function authorizedVaultKeyringEventJson(
  value: AuthorizedVaultKeyringEvent,
): Promise<string> {
  return canonicalJson(await normalizeAuthorizedVaultKeyringEvent(value));
}

async function grantSetJson(grants: readonly HpkeEpochKeyGrant[]): Promise<string> {
  return canonicalJson(grants.toSorted(grantsOrder).map((grant) => JSON.parse(epochKeyGrantJson(grant))));
}

export interface VaultKeyringCommitState {
  readonly existingEvent?: AuthorizedVaultKeyringEvent;
  readonly existingEpoch?: VaultEpochRecord;
  readonly activeEpoch?: VaultEpochRecord;
  readonly existingGrants: readonly HpkeEpochKeyGrant[];
}


export function deriveVaultKeyringCommitState(input: {
  readonly event: AuthorizedVaultKeyringEvent;
  readonly events: readonly AuthorizedVaultKeyringEvent[];
  readonly epochs: readonly VaultEpochRecord[];
  readonly grants: readonly HpkeEpochKeyGrant[];
}): VaultKeyringCommitState {
  const transition = input.event.transition;
  const existingEvent = input.events.find(
    (item) => item.transition.eventId === transition.eventId,
  );
  const existingEpoch = input.epochs.find(
    (item) => item.epochId === transition.epoch.epochId,
  );
  const activeEpoch = deriveActiveVaultEpoch(input.epochs, transition.principal);
  const existingGrants = orderedVaultGrantsForEpoch(input.grants, transition.epoch.epochId);
  return {
    ...(existingEvent === undefined ? {} : { existingEvent }),
    ...(existingEpoch === undefined ? {} : { existingEpoch }),
    ...(activeEpoch === undefined ? {} : { activeEpoch }),
    existingGrants,
  };
}

export async function validateVaultKeyringCommit(
  eventInput: AuthorizedVaultKeyringEvent,
  state: VaultKeyringCommitState,
): Promise<"inserted" | "replayed"> {
  const event = await normalizeAuthorizedVaultKeyringEvent(eventInput);
  if (state.existingEvent !== undefined) {
    if (
      await authorizedVaultKeyringEventJson(state.existingEvent)
      !== await authorizedVaultKeyringEventJson(event)
    ) {
      throw new VaultKeyringConflictError(
        `vault keyring event ${event.transition.eventId} collides with different content`,
      );
    }
    return "replayed";
  }
  const transition = event.transition;
  const existingGrants = state.existingGrants.map(normalizeEpochKeyGrant).toSorted(grantsOrder);
  const addedIds = transition.grantsAdded.map((grant) => grant.recipientKeyId);
  const existingIds = existingGrants.map((grant) => grant.recipientKeyId);
  if (new Set([...existingIds, ...addedIds]).size !== existingIds.length + addedIds.length) {
    throw new VaultKeyringConflictError("vault keyring transition would replace an existing immutable grant");
  }
  const resultingIds = [...existingIds, ...addedIds].toSorted((left, right) => left.localeCompare(right));
  if (!idsEqual(resultingIds, transition.resultingRecipientKeyIds)) {
    throw new VaultKeyringConflictError("vault keyring resulting recipient inventory disagrees with stored grants");
  }

  if (transition.operation === "bootstrap-epoch") {
    if (state.activeEpoch !== undefined || state.existingEpoch !== undefined || existingGrants.length > 0) {
      throw new VaultKeyringConflictError("vault principal already has epoch state");
    }
  } else if (transition.operation === "rotate-epoch") {
    if (state.existingEpoch !== undefined) throw new VaultKeyringConflictError("vault epoch id already exists");
    if (
      state.activeEpoch === undefined
      || transition.epoch.predecessorEpochId !== state.activeEpoch.epochId
      || !samePrincipal(state.activeEpoch.principal, transition.principal)
    ) {
      throw new VaultKeyringConflictError("vault rotation predecessor is not the current active epoch");
    }
  } else {
    if (
      state.existingEpoch === undefined
      || canonicalJson(normalizeVaultEpochRecord(state.existingEpoch))
        !== canonicalJson(transition.epoch)
    ) {
      throw new VaultKeyringConflictError("historical grant extension epoch metadata disagrees with stored epoch");
    }
    if (transition.grantsAdded.length === 0) {
      throw new VaultKeyringConflictError("historical grant extension adds no missing recipient grants");
    }
  }
  return "inserted";
}

function recipientSnapshotJson(values: readonly TrustedEncryptionKeyBinding[]): Promise<string> {
  return normalizeVaultRecipientSnapshot(values).then((normalized) => canonicalJson(normalized));
}

async function currentRecipients(
  repository: Pick<DeviceTrustRepository, "activeEncryptionRecipients">,
  principal: AccessPrincipal,
): Promise<TrustedEncryptionKeyBinding[]> {
  return normalizeVaultRecipientSnapshot(await repository.activeEncryptionRecipients(principal));
}

async function ensureRecipientSnapshotStable(
  repository: Pick<DeviceTrustRepository, "activeEncryptionRecipients">,
  principal: AccessPrincipal,
  expected: readonly TrustedEncryptionKeyBinding[],
): Promise<void> {
  const current = await currentRecipients(repository, principal);
  if (await recipientSnapshotJson(current) !== await recipientSnapshotJson(expected)) {
    throw new VaultKeyringConflictError("trusted encryption recipients changed during vault transition");
  }
}

async function grantsForRecipients(
  epochId: VaultEpochId,
  epochSecret: VaultEpochSecret,
  recipients: readonly TrustedEncryptionKeyBinding[],
): Promise<HpkeEpochKeyGrant[]> {
  return Promise.all(recipients.map((recipient) => createEpochKeyGrant({
    epochId,
    epochSecret,
    recipientPublicKeyJwk: recipient.publicKeyJwk,
  }))).then((grants) => grants.toSorted(grantsOrder));
}

function issuerTransitionFields(
  authorization: ActiveDeviceAuthorization,
  input: VaultEpochMutationInput,
  createdAt: string,
) {
  return {
    issuerDeviceId: authorization.device.deviceId,
    issuerSigningKeyId: authorization.key.keyId,
    issuerPublicKeyJwk: authorization.key.publicKeyJwk,
    audience: requiredString(input.audience, "vault audience"),
    createdAt,
  } as const;
}

export class VaultKeyringManager {
  readonly #repository: VaultKeyringRepository;
  readonly #deviceTrustManager: Pick<DeviceTrustManager, "activeAuthorization">;
  readonly #deviceTrustRepository: Pick<DeviceTrustRepository, "activeEncryptionRecipients">;
  readonly #now: () => number;

  constructor(options: VaultKeyringManagerOptions) {
    this.#repository = options.repository;
    this.#deviceTrustManager = options.deviceTrustManager;
    this.#deviceTrustRepository = options.deviceTrustRepository;
    this.#now = options.now ?? Date.now;
  }

  async #replay(
    eventIdInput: string,
    operationExpected: VaultKeyringOperation,
    authorizingKeyIdInput: string,
    audienceInput: string,
    epochId?: VaultEpochId,
    reason?: VaultEpochReason,
  ): Promise<VaultKeyringMutationResult | undefined> {
    const eventId = requiredString(eventIdInput, "vault eventId");
    const existing = await this.#repository.event(eventId);
    if (existing === undefined) return undefined;
    const event = await normalizeAuthorizedVaultKeyringEvent(existing);
    if (
      event.transition.operation !== operationExpected
      || event.transition.issuerSigningKeyId !== requiredString(authorizingKeyIdInput, "authorizingKeyId")
      || event.transition.audience !== requiredString(audienceInput, "vault audience")
      || (epochId !== undefined && event.transition.epoch.epochId !== normalizeVaultEpochId(epochId))
      || (reason !== undefined && event.transition.epoch.reason !== reason)
    ) {
      throw new VaultKeyringConflictError(`vault event ${eventId} collides with different request content`);
    }
    const persistedGrants = await this.#repository.grantsForEpoch(
      event.transition.epoch.epochId,
    );
    return {
      outcome: "replayed",
      event,
      epoch: event.transition.epoch,
      grants: vaultGrantsForRecipientInventory(
        persistedGrants,
        event.transition.resultingRecipientKeyIds,
      ),
    };
  }

  async #authorization(authorizingKeyIdInput: string) {
    const authorizingKeyId = requiredString(authorizingKeyIdInput, "authorizingKeyId");
    return this.#deviceTrustManager.activeAuthorization(authorizingKeyId);
  }

  async #signedEvent(
    transition: VaultKeyringTransition,
    privateKey: CryptoKey,
  ): Promise<AuthorizedVaultKeyringEvent> {
    const normalized = await normalizeVaultKeyringTransition(transition);
    const signature = await signTransition(normalized, privateKey);
    const event = {
      schema: VAULT_KEYRING_EVENT_SCHEMA,
      transition: normalized,
      signature,
    } as const;
    if (!(await verifyAuthorizedVaultKeyringEvent(event))) {
      throw new VaultKeyringProofError("authorizing private key does not match active signing generation");
    }
    return event;
  }

  async #createNewEpoch(
    input: VaultEpochMutationInput,
    authorization: ActiveDeviceAuthorization,
    operation: "bootstrap-epoch" | "rotate-epoch",
    reason: VaultEpochReason,
    predecessorEpochId?: VaultEpochId,
  ): Promise<VaultKeyringMutationResult> {
    const principal = authorization.device.principal;
    const recipients = await currentRecipients(this.#deviceTrustRepository, principal);
    if (recipients.length === 0) {
      throw new VaultKeyringAuthorizationError("vault epoch transition requires at least one active encryption recipient");
    }
    const generated = generateVaultEpoch();
    try {
      const createdAt = nowIso(this.#now);
      const epoch = normalizeVaultEpochRecord({
        epochId: generated.epochId,
        principal,
        ...(predecessorEpochId === undefined ? {} : { predecessorEpochId }),
        createdAt,
        reason,
        createdByDeviceId: authorization.device.deviceId,
        createdBySigningKeyId: authorization.key.keyId,
      });
      const grantsAdded = await grantsForRecipients(epoch.epochId, generated.secret, recipients);
      await ensureRecipientSnapshotStable(this.#deviceTrustRepository, principal, recipients);
      const event = await this.#signedEvent({
        schema: VAULT_KEYRING_TRANSITION_SCHEMA,
        eventId: requiredString(input.eventId, "vault eventId"),
        operation,
        principal,
        epoch,
        activeRecipients: recipients,
        grantsAdded,
        resultingRecipientKeyIds: grantsAdded.map((grant) => grant.recipientKeyId),
        ...issuerTransitionFields(authorization, input, createdAt),
      }, input.authorizingPrivateKey);
      await ensureRecipientSnapshotStable(this.#deviceTrustRepository, principal, recipients);
      const committed = await this.#repository.commit(event);
      return { ...committed, epochSecret: generated.secret };
    } catch (cause) {
      generated.secret.fill(0);
      throw cause;
    }
  }

  async bootstrapEpoch(input: VaultEpochMutationInput): Promise<VaultKeyringMutationResult> {
    const replay = await this.#replay(
      input.eventId,
      "bootstrap-epoch",
      input.authorizingKeyId,
      input.audience,
      undefined,
      "bootstrap",
    );
    if (replay !== undefined) return replay;
    const authorization = await this.#authorization(input.authorizingKeyId);
    if (await this.#repository.activeEpoch(authorization.device.principal) !== undefined) {
      throw new VaultKeyringConflictError("vault principal already has an active epoch");
    }
    return this.#createNewEpoch(input, authorization, "bootstrap-epoch", "bootstrap");
  }

  async rotateEpoch(input: RotateVaultEpochInput): Promise<VaultKeyringMutationResult> {
    const replay = await this.#replay(
      input.eventId,
      "rotate-epoch",
      input.authorizingKeyId,
      input.audience,
      undefined,
      input.reason,
    );
    if (replay !== undefined) return replay;
    const authorization = await this.#authorization(input.authorizingKeyId);
    const previous = await this.#repository.activeEpoch(authorization.device.principal);
    if (previous === undefined) {
      throw new VaultKeyringConflictError("vault principal has no active epoch to rotate");
    }
    return this.#createNewEpoch(
      input,
      authorization,
      "rotate-epoch",
      input.reason,
      previous.epochId,
    );
  }

  async extendHistoricalGrants(
    input: ExtendHistoricalGrantsInput,
  ): Promise<VaultKeyringMutationResult> {
    const epochId = normalizeVaultEpochId(input.epochId);
    const replay = await this.#replay(
      input.eventId,
      "extend-historical-grants",
      input.authorizingKeyId,
      input.audience,
      epochId,
    );
    if (replay !== undefined) return replay;
    const authorization = await this.#authorization(input.authorizingKeyId);
    const epoch = await this.#repository.epoch(epochId);
    if (epoch === undefined || !samePrincipal(epoch.principal, authorization.device.principal)) {
      throw new VaultKeyringAuthorizationError("historical vault epoch is unavailable to authorizing principal");
    }
    const sourcePublicJwk = x25519PublicFromPrivate(input.sourceRecipientPrivateKeyJwk);
    const sourceKeyId = await x25519JwkThumbprintUri(sourcePublicJwk);
    const sourceGrant = await this.#repository.grant(epochId, sourceKeyId);
    if (sourceGrant === undefined) {
      throw new VaultKeyringAuthorizationError("source X25519 key has no historical grant for this epoch");
    }
    let epochSecret: VaultEpochSecret;
    try {
      epochSecret = await openEpochKeyGrant(sourceGrant, input.sourceRecipientPrivateKeyJwk);
    } catch (cause) {
      throw new VaultKeyringProofError("source X25519 private key cannot open the historical epoch grant", { cause });
    }
    try {
      const recipients = await currentRecipients(this.#deviceTrustRepository, epoch.principal);
      const existingGrants = await this.#repository.grantsForEpoch(epochId);
      const existingIds = new Set(existingGrants.map((grant) => grant.recipientKeyId));
      const missingRecipients = recipients.filter((recipient) => !existingIds.has(recipient.encryptionKeyId));
      if (missingRecipients.length === 0) {
        throw new VaultKeyringConflictError("historical epoch already has grants for every active recipient");
      }
      const grantsAdded = await grantsForRecipients(epochId, epochSecret, missingRecipients);
      await ensureRecipientSnapshotStable(this.#deviceTrustRepository, epoch.principal, recipients);
      const resultingRecipientKeyIds = [...existingIds, ...grantsAdded.map((grant) => grant.recipientKeyId)]
        .toSorted((left, right) => left.localeCompare(right));
      const createdAt = nowIso(this.#now);
      const event = await this.#signedEvent({
        schema: VAULT_KEYRING_TRANSITION_SCHEMA,
        eventId: requiredString(input.eventId, "vault eventId"),
        operation: "extend-historical-grants",
        principal: epoch.principal,
        epoch,
        activeRecipients: recipients,
        grantsAdded,
        resultingRecipientKeyIds,
        ...issuerTransitionFields(authorization, input, createdAt),
      }, input.authorizingPrivateKey);
      await ensureRecipientSnapshotStable(
        this.#deviceTrustRepository,
        epoch.principal,
        recipients,
      );
      return await this.#repository.commit(event);
    } finally {
      epochSecret.fill(0);
    }
  }
}

export class InMemoryVaultKeyringRepository implements VaultKeyringRepository {
  readonly #events = new Map<string, AuthorizedVaultKeyringEvent>();
  readonly #epochs = new Map<VaultEpochId, VaultEpochRecord>();
  readonly #grants = new Map<string, HpkeEpochKeyGrant>();

  #grantKey(epochId: VaultEpochId, recipientKeyId: string): string {
    return `${epochId}\n${recipientKeyId}`;
  }

  async event(eventId: string): Promise<AuthorizedVaultKeyringEvent | undefined> {
    return this.#events.get(eventId);
  }

  async epoch(epochId: VaultEpochId): Promise<VaultEpochRecord | undefined> {
    return this.#epochs.get(epochId);
  }

  async activeEpoch(principal: AccessPrincipal): Promise<VaultEpochRecord | undefined> {
    return deriveActiveVaultEpoch([...this.#epochs.values()], principal);
  }

  async epochsForPrincipal(principal: AccessPrincipal): Promise<readonly VaultEpochRecord[]> {
    return orderedVaultEpochsForPrincipal([...this.#epochs.values()], principal);
  }

  async grantsForEpoch(epochId: VaultEpochId): Promise<readonly HpkeEpochKeyGrant[]> {
    return orderedVaultGrantsForEpoch([...this.#grants.values()], epochId);
  }

  async grant(epochId: VaultEpochId, recipientKeyId: string): Promise<HpkeEpochKeyGrant | undefined> {
    return this.#grants.get(this.#grantKey(epochId, recipientKeyId));
  }

  async commit(eventInput: AuthorizedVaultKeyringEvent): Promise<VaultKeyringCommitResult> {
    const event = await normalizeAuthorizedVaultKeyringEvent(eventInput);
    const transition = event.transition;
    const state = deriveVaultKeyringCommitState({
      event,
      events: [...this.#events.values()],
      epochs: [...this.#epochs.values()],
      grants: [...this.#grants.values()],
    });
    const outcome = await validateVaultKeyringCommit(event, state);
    if (outcome === "inserted") {
      if (transition.operation !== "extend-historical-grants") {
        this.#epochs.set(transition.epoch.epochId, transition.epoch);
      }
      for (const grant of transition.grantsAdded) {
        this.#grants.set(this.#grantKey(grant.epochId, grant.recipientKeyId), grant);
      }
      this.#events.set(transition.eventId, event);
    }
    const persistedEvent = this.#events.get(transition.eventId)!;
    const allGrants = await this.grantsForEpoch(transition.epoch.epochId);
    return {
      outcome,
      event: persistedEvent,
      epoch: this.#epochs.get(transition.epoch.epochId)!,
      grants: vaultGrantsForRecipientInventory(
        allGrants,
        persistedEvent.transition.resultingRecipientKeyIds,
      ),
    };
  }
}
