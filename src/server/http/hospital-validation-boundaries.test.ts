import { describe, expect, it } from "vitest";
import { userRoleSchema } from "./admin-schemas";
import { laboratoryPopulationSchema, prepareExamTemplateSchema } from "./exam-definition-schemas";
import { hospitalHisV4MappingsSchema } from "./hospital-his-v4-schemas";
import { hospitalInvitationCreateSchema } from "./hospital-institution-schemas";
import { hospitalTaskPatchSchema } from "./hospital-task-schemas";
import { hisV4Config } from "../../test/hospital-his-v4-fixtures";

describe("hospital configuration input boundaries", () => {
  it("accepts a valid identity update but rejects an unbounded or injected email", () => {
    const identity = { role: "VETERINARIAN", departmentCode: "INPATIENT", email: "clinician@example.test" };
    expect(userRoleSchema.parse(identity)).toEqual(identity);
    expect(userRoleSchema.safeParse({ ...identity, email: `${"a".repeat(310)}@example.test` }).success).toBe(false);
    expect(userRoleSchema.safeParse({ ...identity, permissions: ["user.manage"] }).success).toBe(false);
  });

  it.each([
    [{ species: ["Canino"], minAgeDays: 9 }, true],
    [{ species: ["Canino"], maxAgeDays: 9 }, true],
    [{ species: ["Canino"], minAgeDays: 9, maxAgeDays: 9 }, true],
    [{ species: ["Canino"], minAgeDays: 10, maxAgeDays: 9 }, false]
  ])("validates declared laboratory population bounds %j", (population, accepted) => {
    expect(laboratoryPopulationSchema.safeParse(population).success).toBe(accepted);
  });

  it.each([
    [{ kind: "NUMERIC", low: 0 }, true],
    [{ kind: "NUMERIC", high: 0 }, true],
    [{ kind: "NUMERIC" }, false],
    [{ kind: "NUMERIC", low: 2, high: 1 }, false],
    [{ kind: "PENDING_POLICY" }, true]
  ])("distinguishes a one-sided laboratory range from missing or inverted limits %j", (bounds, accepted) => {
    const input = { expectedVersion: 1, template: { code: "SYNTHETIC_PANEL", name: "Sintético, sem aprovação clínica", schemaVersion: "1", analytes: [{ code: "VALUE", label: "Valor sintético", valueType: "NUMERIC", unitCode: "test/unit", required: true, displayOrder: 1, referenceRange: { ...bounds, unitCode: "test/unit", source: "PENDING_HUMAN_POLICY" } }] } };
    expect(prepareExamTemplateSchema.safeParse(input).success).toBe(accepted);
    expect(prepareExamTemplateSchema.safeParse({ ...input, template: { ...input.template, analytes: [{ ...input.template.analytes[0], referenceRange: { ...input.template.analytes[0].referenceRange, unitCode: "wrong/unit" } }] } }).success).toBe(false);
  });

  it.each(["patients", "encounters"] as const)("refuses many-to-one and one-to-many HIS %s mappings", (collection) => {
    const mappings = hisV4Config().webhook!.mappings;
    expect(hospitalHisV4MappingsSchema.safeParse(mappings).success).toBe(true);
    const link = mappings[collection][0];
    for (const conflicting of [{ hisId: link.hisId, hubId: "other-hub" }, { hisId: "other-his", hubId: link.hubId }]) {
      const result = hospitalHisV4MappingsSchema.safeParse({ ...mappings, [collection]: [link, conflicting] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: [collection] })]));
    }
  });

  it("does not silently expand an invitation through repeated services or a privileged role", () => {
    const invitation = { email: "recipient@example.test", displayName: "Destinatário sintético", role: "LAB_TECH", departmentCode: "LAB", accessGroupId: "group-synthetic", expectedGroupVersion: 1, serviceCodes: ["HEMOGRAM", "BIOCHEMISTRY"], expiresInHours: 24 };
    expect(hospitalInvitationCreateSchema.parse(invitation).serviceCodes).toEqual(invitation.serviceCodes);
    expect(hospitalInvitationCreateSchema.safeParse({ ...invitation, serviceCodes: ["HEMOGRAM", "HEMOGRAM"] }).success).toBe(false);
    expect(hospitalInvitationCreateSchema.safeParse({ ...invitation, role: "SUPERADMIN" }).success).toBe(false);
  });

  it("requires unique document bindings on an existing task and preserves explicit clearing", () => {
    expect(hospitalTaskPatchSchema.parse({ documentIds: ["doc-one", "doc-two"], expectedVersion: 3 }).documentIds).toEqual(["doc-one", "doc-two"]);
    expect(hospitalTaskPatchSchema.parse({ documentIds: [], descriptionContent: null, expectedVersion: 3 })).toMatchObject({ documentIds: [], descriptionContent: null });
    expect(hospitalTaskPatchSchema.safeParse({ documentIds: ["doc-one", "doc-one"], expectedVersion: 3 }).success).toBe(false);
  });
});
