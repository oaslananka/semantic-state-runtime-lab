export type EntityId = `entity://${string}`;
export type ProviderId = string;
export type PropertyPath = string;
export type Revision = string;

export type StateValue =
  | null
  | boolean
  | number
  | string
  | readonly StateValue[]
  | { readonly [key: string]: StateValue };

export interface SourceRef {
  readonly provider: ProviderId;
  readonly externalId: string;
  readonly revision?: Revision;
}

export interface CandidateValue {
  readonly entityId: EntityId;
  readonly property: PropertyPath;
  readonly value: StateValue;
  readonly source: SourceRef;
  readonly observedAt: string;
  readonly confidence?: number;
}

export interface BindingField {
  readonly canonical: PropertyPath;
  readonly external: string;
  readonly readable: boolean;
  readonly writable: boolean;
}

export interface ExternalBinding {
  readonly entityId: EntityId;
  readonly provider: ProviderId;
  readonly externalId: string;
  readonly fields: readonly BindingField[];
}

export interface ExternalSnapshot {
  readonly binding: ExternalBinding;
  readonly revision?: Revision;
  readonly observedAt: string;
  readonly values: Readonly<Record<string, StateValue | undefined>>;
}

export type AuthorityStrategy =
  | { readonly kind: "provider"; readonly provider: ProviderId; readonly fallback?: readonly ProviderId[] }
  | { readonly kind: "freshest" };

export interface AuthorityRule {
  readonly property: PropertyPath;
  readonly strategy: AuthorityStrategy;
}

export interface CanonicalPropertyState {
  readonly property: PropertyPath;
  readonly value: StateValue;
  readonly source: SourceRef;
  readonly observedAt: string;
}

export interface CanonicalState {
  readonly entityId: EntityId;
  readonly properties: Readonly<Record<PropertyPath, CanonicalPropertyState>>;
}

export interface Mutation {
  readonly provider: ProviderId;
  readonly externalId: string;
  readonly externalPath: string;
  readonly canonicalProperty: PropertyPath;
  readonly nextValue: StateValue;
  readonly previousValue?: StateValue;
  readonly baseRevision?: Revision;
}

export interface ConflictCandidate {
  readonly provider: ProviderId;
  readonly externalId: string;
  readonly value: StateValue;
  readonly observedAt: string;
}

export interface Conflict {
  readonly property: PropertyPath;
  readonly reason: "ambiguous-authority" | "ambiguous-freshest";
  readonly candidates: readonly ConflictCandidate[];
}

export interface ReconciliationPlan {
  readonly entityId: EntityId;
  readonly canonical: CanonicalState;
  readonly mutations: readonly Mutation[];
  readonly conflicts: readonly Conflict[];
}
