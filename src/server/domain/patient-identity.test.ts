import { describe, expect, it } from "vitest";
import {
  compareScopedIdentity,
  normalizePatientIdentity,
  normalizeScopedIdentity,
  resolvePatientIdentity,
  resolveScopedIdentity,
  type ScopedIdentityInput
} from "./patient-identity";

function identity(overrides: Partial<ScopedIdentityInput> = {}): ScopedIdentityInput {
  return {
    entityType: "PATIENT",
    scope: { institutionCode: " hospital-01 ", sourceSystem: "his" },
    externalId: " his-thor-001 ",
    provenance: { sourceRecordId: "row-001", sourceVersion: "v1" },
    ...overrides
  };
}

function patient(localId: string, overrides: Partial<ScopedIdentityInput> = {}): ScopedIdentityInput {
  return { ...identity(overrides), localId };
}

describe("scoped patient identity contract", () => {
  it("normalizes only the identifier namespace and keeps provenance", () => {
    const result = normalizePatientIdentity({
      scope: { institutionCode: " ｈｏｓｐｉｔａｌ－０１ ", sourceSystem: " HIS " },
      externalId: " ｈｉｓ－ｔｈｏｒ－００１ ",
      provenance: { sourceRecordId: " row-001 ", sourceVersion: "v1" },
      localId: "patient-thor"
    });

    expect(result).toEqual({
      ok: true,
      value: {
        entityType: "PATIENT",
        scope: { institutionCode: "HOSPITAL-01", sourceSystem: "HIS" },
        externalId: "HIS-THOR-001",
        provenance: { sourceRecordId: "row-001", sourceVersion: "v1" },
        localId: "patient-thor",
        key: expect.stringContaining("AAA2-IDENTITY-V1")
      }
    });
  });

  it("rejects an owner or another entity when the patient-only helper is used", () => {
    expect(normalizePatientIdentity(identity({ entityType: "OWNER" }))).toMatchObject({
      ok: false,
      code: "INVALID_ENTITY_TYPE",
      field: "entityType"
    });
    expect(resolvePatientIdentity(identity(), [patient("patient-owner", { entityType: "OWNER" }) as never])).toMatchObject({
      status: "INVALID",
      error: { code: "INVALID_ENTITY_TYPE", field: "entityType" }
    });
  });

  it("matches exact identifiers only within the same entity and scope", () => {
    const left = { ...identity(), provenance: undefined };
    expect(compareScopedIdentity(left, { ...identity({ externalId: "HIS-THOR-001" }), provenance: undefined }).status).toBe("MATCH");
    expect(compareScopedIdentity(left, { ...identity({ scope: { institutionCode: "other-hospital", sourceSystem: "his" } }), provenance: undefined }).status).toBe("NO_MATCH");
    expect(compareScopedIdentity(left, identity({ entityType: "OWNER", localId: "owner-1" })).status).toBe("NO_MATCH");
    expect(compareScopedIdentity(left, { ...identity({ externalId: "HIS-THOR-00" }), provenance: undefined }).status).toBe("NO_MATCH");
  });

  it("does not create a delimiter collision between distinct scopes", () => {
    const first = identity({ scope: { institutionCode: "AB", sourceSystem: "C" } });
    const second = identity({ scope: { institutionCode: "A", sourceSystem: "BC" } });
    const comparison = compareScopedIdentity(first, second);
    expect(comparison.status).toBe("NO_MATCH");
  });

  it("resolves a unique patient and is independent of candidate ordering", () => {
    const query = identity();
    const first = patient("patient-thor");
    const unrelated = patient("patient-mel", { externalId: "HIS-MEL-001" });
    const resolution = resolvePatientIdentity(query, [unrelated as never, first as never]);

    expect(resolution).toMatchObject({ status: "MATCH", candidate: { localId: "patient-thor", externalId: "HIS-THOR-001" } });
  });

  it("fails closed when the same scoped identifier has more than one candidate", () => {
    const resolution = resolvePatientIdentity(identity(), [
      patient("patient-zeta", { provenance: { sourceRecordId: "row-zeta" } }) as never,
      patient("patient-alpha", { provenance: { sourceRecordId: "row-alpha" } }) as never
    ]);

    expect(resolution).toEqual({
      status: "AMBIGUOUS",
      key: expect.stringContaining("AAA2-IDENTITY-V1"),
      candidateLocalIds: ["patient-alpha", "patient-zeta"]
    });
  });

  it("never falls back to names or owner-like values and rejects malformed data", () => {
    expect(normalizeScopedIdentity(identity({ externalId: "THOR 001" })).ok).toBe(false);
    expect(normalizeScopedIdentity(identity({ scope: { institutionCode: "HOSPITAL", sourceSystem: "HIS/LEGACY" } })).ok).toBe(false);
    expect(compareScopedIdentity(identity(), identity({ provenance: { sourceRecordId: "" } }))).toMatchObject({ status: "INVALID" });

    const invalidCandidate = { ...patient("patient-bad"), externalId: "HIS THOR 001" };
    expect(resolvePatientIdentity(identity(), [invalidCandidate as never])).toMatchObject({ status: "INVALID" });
  });

  it("keeps patient and encounter namespaces distinct even with the same source value", () => {
    const patientIdentity = identity({ entityType: "PATIENT" });
    const encounterIdentity = identity({ entityType: "ENCOUNTER", localId: "encounter-1" });
    expect(compareScopedIdentity(patientIdentity, encounterIdentity).status).toBe("NO_MATCH");

    const encounterResolution = resolveScopedIdentity(encounterIdentity, [encounterIdentity]);
    expect(encounterResolution).toMatchObject({ status: "MATCH", candidate: { entityType: "ENCOUNTER", localId: "encounter-1" } });
  });

  it("treats a duplicated row as ambiguous even when its local id repeats", () => {
    const candidate = patient("patient-thor");
    const resolution = resolvePatientIdentity(identity(), [candidate as never, candidate as never]);
    expect(resolution).toMatchObject({ status: "AMBIGUOUS", candidateLocalIds: ["patient-thor", "patient-thor"] });
  });

  it("requires provenance for a candidate that can be persisted or resolved", () => {
    const candidateWithoutProvenance = { ...patient("patient-thor"), provenance: undefined };
    expect(normalizePatientIdentity(candidateWithoutProvenance)).toMatchObject({
      ok: false,
      code: "INVALID_PROVENANCE",
      field: "sourceRecordId"
    });
    expect(resolvePatientIdentity(identity(), [candidateWithoutProvenance as never])).toMatchObject({
      status: "INVALID",
      error: { code: "INVALID_PROVENANCE", field: "sourceRecordId" }
    });
  });

  it("rejects malformed scope, references and persistence candidates without guessing", () => {
    expect(normalizeScopedIdentity(null)).toMatchObject({ ok: false, code: "INVALID_TYPE" });
    expect(normalizeScopedIdentity({ ...identity(), scope: null })).toMatchObject({ ok: false, code: "INVALID_SCOPE" });
    expect(normalizeScopedIdentity({ ...identity(), scope: { institutionCode: "", sourceSystem: "HIS" } })).toMatchObject({ ok: false, code: "EMPTY_VALUE", field: "institutionCode" });
    expect(normalizeScopedIdentity({ ...identity(), externalId: "A".repeat(101) })).toMatchObject({ ok: false, code: "VALUE_TOO_LONG", field: "externalId" });
    expect(normalizeScopedIdentity({ ...identity(), provenance: "row-1" })).toMatchObject({ ok: false, code: "INVALID_PROVENANCE" });
    expect(normalizeScopedIdentity({ ...identity(), provenance: { sourceRecordId: "row-1", sourceVersion: "\u0000" } })).toMatchObject({ ok: false, code: "INVALID_FORMAT", field: "sourceVersion" });
    expect(normalizeScopedIdentity({ ...identity(), provenance: undefined, localId: "patient-1" })).toMatchObject({ ok: false, code: "INVALID_PROVENANCE" });
    expect(normalizeScopedIdentity({ ...identity(), localId: " " })).toMatchObject({ ok: false, code: "EMPTY_VALUE", field: "localId" });
    expect(resolveScopedIdentity({ ...identity(), entityType: "UNKNOWN" }, [])).toMatchObject({ status: "INVALID", error: { code: "INVALID_ENTITY_TYPE" } });
    expect(compareScopedIdentity(identity(), { ...identity(), externalId: "" })).toMatchObject({ status: "INVALID" });
    expect(resolveScopedIdentity(identity(), [{ ...identity(), provenance: { sourceRecordId: "row" } }])).toMatchObject({ status: "INVALID", error: { code: "EMPTY_VALUE", field: "localId" } });
  });
});
