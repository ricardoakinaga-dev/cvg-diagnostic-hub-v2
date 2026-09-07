/**
 * Deterministic identity contract for imported clinical references.
 *
 * This module deliberately matches only an exact, scoped external identifier.
 * Display names, owner labels, species, dates and other clinical attributes are
 * not identity evidence here. A caller that needs a human reconciliation flow
 * must handle it explicitly instead of turning a fuzzy match into a patient
 * link.
 */

export const IDENTITY_ENTITY_TYPES = ["PATIENT", "OWNER", "ENCOUNTER", "ADMISSION"] as const;
export type IdentityEntityType = (typeof IDENTITY_ENTITY_TYPES)[number];

export interface IdentityScope {
  /** Institution or tenant that owns the identifier namespace. */
  institutionCode: string;
  /** Upstream system that issued the identifier. */
  sourceSystem: string;
}

export interface IdentityProvenance {
  /** Identifier of the source row/document; it is retained through normalization. */
  sourceRecordId: string;
  /** Optional source revision, retained for reconciliation/audit. */
  sourceVersion?: string;
}

export interface ScopedIdentityInput {
  entityType: IdentityEntityType;
  scope: IdentityScope;
  externalId: string;
  /** Source provenance is required for persisted records and optional for lookup queries. */
  provenance?: IdentityProvenance;
  /** Local canonical identifier. Omit this for a lookup query. */
  localId?: string;
}

export interface NormalizedIdentityScope {
  readonly institutionCode: string;
  readonly sourceSystem: string;
}

export interface NormalizedIdentityProvenance {
  readonly sourceRecordId: string;
  readonly sourceVersion?: string;
}

export interface NormalizedScopedIdentity {
  readonly entityType: IdentityEntityType;
  readonly scope: NormalizedIdentityScope;
  readonly externalId: string;
  readonly provenance?: NormalizedIdentityProvenance;
  readonly localId?: string;
  /** Versioned, collision-resistant key for exact comparisons and indexes. */
  readonly key: string;
}

export type IdentityNormalizationField =
  | "entityType"
  | "institutionCode"
  | "sourceSystem"
  | "externalId"
  | "sourceRecordId"
  | "sourceVersion"
  | "localId";

export type IdentityNormalizationErrorCode =
  | "INVALID_TYPE"
  | "EMPTY_VALUE"
  | "INVALID_ENTITY_TYPE"
  | "INVALID_FORMAT"
  | "VALUE_TOO_LONG"
  | "INVALID_SCOPE"
  | "INVALID_PROVENANCE";

export interface IdentityNormalizationFailure {
  readonly ok: false;
  readonly code: IdentityNormalizationErrorCode;
  readonly field: IdentityNormalizationField;
}

export interface IdentityNormalizationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type IdentityNormalizationResult<T> = IdentityNormalizationSuccess<T> | IdentityNormalizationFailure;

export type IdentityComparison =
  | { readonly status: "MATCH"; readonly key: string }
  | { readonly status: "NO_MATCH" }
  | { readonly status: "INVALID"; readonly error: IdentityNormalizationFailure };

export type IdentityResolution =
  | { readonly status: "MATCH"; readonly candidate: NormalizedScopedIdentity }
  | { readonly status: "NO_MATCH"; readonly key: string }
  | { readonly status: "AMBIGUOUS"; readonly key: string; readonly candidateLocalIds: readonly string[] }
  | { readonly status: "INVALID"; readonly error: IdentityNormalizationFailure };

const MAX_SCOPE_COMPONENT_LENGTH = 80;
const MAX_EXTERNAL_ID_LENGTH = 100;
const MAX_PROVENANCE_ID_LENGTH = 160;
const MAX_LOCAL_ID_LENGTH = 160;
const IDENTITY_KEY_VERSION = "AAA2-IDENTITY-V1";

function failure(
  code: IdentityNormalizationErrorCode,
  field: IdentityNormalizationField
): IdentityNormalizationFailure {
  return { ok: false, code, field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize a namespace/identifier token without removing characters or
 * collapsing internal whitespace. The allow-list is intentional: an input
 * outside it is rejected rather than guessed at.
 */
function normalizeToken(
  value: unknown,
  field: IdentityNormalizationField,
  maxLength: number
): IdentityNormalizationResult<string> {
  if (typeof value !== "string") return failure("INVALID_TYPE", field);
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (normalized.length === 0) return failure("EMPTY_VALUE", field);
  if (Array.from(normalized).length > maxLength) return failure("VALUE_TOO_LONG", field);
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(normalized)) return failure("INVALID_FORMAT", field);
  return { ok: true, value: normalized };
}

/**
 * Source revisions and local IDs are opaque references. They are normalized
 * for stable storage, while their case is preserved because their source may
 * define case-sensitive semantics. They still reject whitespace/control data.
 */
function normalizeOpaqueReference(
  value: unknown,
  field: "sourceRecordId" | "sourceVersion" | "localId",
  maxLength: number
): IdentityNormalizationResult<string> {
  if (typeof value !== "string") return failure("INVALID_TYPE", field);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) return failure("EMPTY_VALUE", field);
  if (Array.from(normalized).length > maxLength) return failure("VALUE_TOO_LONG", field);
  if (/\s|[\u0000-\u001F\u007F]/u.test(normalized)) return failure("INVALID_FORMAT", field);
  return { ok: true, value: normalized };
}

function normalizeEntityType(value: unknown): IdentityNormalizationResult<IdentityEntityType> {
  if (typeof value !== "string") return failure("INVALID_TYPE", "entityType");
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (!IDENTITY_ENTITY_TYPES.includes(normalized as IdentityEntityType)) {
    return failure("INVALID_ENTITY_TYPE", "entityType");
  }
  return { ok: true, value: normalized as IdentityEntityType };
}

export function normalizeIdentityScope(value: unknown): IdentityNormalizationResult<NormalizedIdentityScope> {
  if (!isRecord(value)) return failure("INVALID_SCOPE", "institutionCode");
  const institutionCode = normalizeToken(value.institutionCode, "institutionCode", MAX_SCOPE_COMPONENT_LENGTH);
  if (!institutionCode.ok) return institutionCode;
  const sourceSystem = normalizeToken(value.sourceSystem, "sourceSystem", MAX_SCOPE_COMPONENT_LENGTH);
  if (!sourceSystem.ok) return sourceSystem;
  return { ok: true, value: { institutionCode: institutionCode.value, sourceSystem: sourceSystem.value } };
}

function normalizeProvenance(value: unknown): IdentityNormalizationResult<NormalizedIdentityProvenance> {
  if (!isRecord(value)) return failure("INVALID_PROVENANCE", "sourceRecordId");
  const sourceRecordId = normalizeOpaqueReference(value.sourceRecordId, "sourceRecordId", MAX_PROVENANCE_ID_LENGTH);
  if (!sourceRecordId.ok) return sourceRecordId;
  if (value.sourceVersion === undefined) return { ok: true, value: { sourceRecordId: sourceRecordId.value } };
  const sourceVersion = normalizeOpaqueReference(value.sourceVersion, "sourceVersion", MAX_PROVENANCE_ID_LENGTH);
  if (!sourceVersion.ok) return sourceVersion;
  return { ok: true, value: { sourceRecordId: sourceRecordId.value, sourceVersion: sourceVersion.value } };
}

function asPatientIdentity(value: unknown): IdentityNormalizationResult<Record<string, unknown>> {
  if (!isRecord(value)) return failure("INVALID_TYPE", "entityType");
  if (value.entityType !== undefined) {
    const entityType = normalizeEntityType(value.entityType);
    if (!entityType.ok) return entityType;
    if (entityType.value !== "PATIENT") return failure("INVALID_ENTITY_TYPE", "entityType");
  }
  return { ok: true, value: { ...value, entityType: "PATIENT" } };
}

/**
 * Length-prefixing each component prevents delimiter collisions while keeping
 * the key stable and inspectable in a database index or audit record.
 */
function identityKey(
  entityType: IdentityEntityType,
  scope: NormalizedIdentityScope,
  externalId: string
): string {
  const parts = [entityType, scope.institutionCode, scope.sourceSystem, externalId];
  return `${IDENTITY_KEY_VERSION}|${parts.map((part) => `${part.length}:${part}`).join("|")}`;
}

export function normalizeScopedIdentity(value: unknown): IdentityNormalizationResult<NormalizedScopedIdentity> {
  if (!isRecord(value)) return failure("INVALID_TYPE", "entityType");

  const entityType = normalizeEntityType(value.entityType);
  if (!entityType.ok) return entityType;
  const scope = normalizeIdentityScope(value.scope);
  if (!scope.ok) return scope;
  const externalId = normalizeToken(value.externalId, "externalId", MAX_EXTERNAL_ID_LENGTH);
  if (!externalId.ok) return externalId;
  const provenance = value.provenance === undefined ? undefined : normalizeProvenance(value.provenance);
  if (provenance !== undefined && !provenance.ok) return provenance;

  let localId: string | undefined;
  if (value.localId !== undefined) {
    const normalizedLocalId = normalizeOpaqueReference(value.localId, "localId", MAX_LOCAL_ID_LENGTH);
    if (!normalizedLocalId.ok) return normalizedLocalId;
    localId = normalizedLocalId.value;
  }
  if (localId !== undefined && provenance === undefined) {
    return failure("INVALID_PROVENANCE", "sourceRecordId");
  }

  return {
    ok: true,
    value: {
      entityType: entityType.value,
      scope: scope.value,
      externalId: externalId.value,
      ...(provenance === undefined ? {} : { provenance: provenance.value }),
      ...(localId === undefined ? {} : { localId }),
      key: identityKey(entityType.value, scope.value, externalId.value)
    }
  };
}

export function normalizePatientIdentity(
  value: Omit<ScopedIdentityInput, "entityType"> | (ScopedIdentityInput & { entityType: "PATIENT" })
): IdentityNormalizationResult<NormalizedScopedIdentity> {
  const candidate = asPatientIdentity(value);
  if (!candidate.ok) return candidate;
  return normalizeScopedIdentity(candidate.value);
}

export function compareScopedIdentity(left: unknown, right: unknown): IdentityComparison {
  const normalizedLeft = normalizeScopedIdentity(left);
  if (!normalizedLeft.ok) return { status: "INVALID", error: normalizedLeft };
  const normalizedRight = normalizeScopedIdentity(right);
  if (!normalizedRight.ok) return { status: "INVALID", error: normalizedRight };
  if (normalizedLeft.value.key !== normalizedRight.value.key) return { status: "NO_MATCH" };
  return { status: "MATCH", key: normalizedLeft.value.key };
}

/**
 * Resolve only an exact scoped identifier. Any malformed candidate fails the
 * resolution instead of being silently discarded, and two rows for the same
 * key are always ambiguous—even if their local IDs happen to be equal.
 */
export function resolveScopedIdentity(
  query: unknown,
  candidates: readonly unknown[]
): IdentityResolution {
  const normalizedQuery = normalizeScopedIdentity(query);
  if (!normalizedQuery.ok) return { status: "INVALID", error: normalizedQuery };
  const normalizedCandidates: NormalizedScopedIdentity[] = [];
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeScopedIdentity(candidate);
    if (!normalizedCandidate.ok) return { status: "INVALID", error: normalizedCandidate };
    if (normalizedCandidate.value.localId === undefined) {
      return { status: "INVALID", error: failure("EMPTY_VALUE", "localId") };
    }
    if (normalizedCandidate.value.provenance === undefined) {
      return { status: "INVALID", error: failure("INVALID_PROVENANCE", "sourceRecordId") };
    }
    normalizedCandidates.push(normalizedCandidate.value);
  }

  const matching = normalizedCandidates.filter((candidate) => candidate.key === normalizedQuery.value.key);
  if (matching.length === 0) return { status: "NO_MATCH", key: normalizedQuery.value.key };
  if (matching.length > 1) {
    return {
      status: "AMBIGUOUS",
      key: normalizedQuery.value.key,
      candidateLocalIds: matching.map((candidate) => candidate.localId!).sort((left, right) => left.localeCompare(right))
    };
  }
  return { status: "MATCH", candidate: matching[0] };
}

export function resolvePatientIdentity(
  query: Omit<ScopedIdentityInput, "entityType" | "localId"> | (ScopedIdentityInput & { entityType: "PATIENT"; localId?: never }),
  candidates: readonly (Omit<ScopedIdentityInput, "entityType"> & { localId: string })[]
): IdentityResolution {
  const patientQuery = asPatientIdentity(query);
  if (!patientQuery.ok) return { status: "INVALID", error: patientQuery };
  const patientCandidates: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const patientCandidate = asPatientIdentity(candidate);
    if (!patientCandidate.ok) return { status: "INVALID", error: patientCandidate };
    patientCandidates.push(patientCandidate.value);
  }
  return resolveScopedIdentity(patientQuery.value, patientCandidates);
}
