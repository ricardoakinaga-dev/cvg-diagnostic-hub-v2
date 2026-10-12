import type { ExamDefinitionSnapshot, LaboratoryPanelTemplate, StructuredLaboratoryResultContent } from "@cvg/contracts";
import { hospitalDateKey, hospitalTimezone } from "@/lib/hospital-time";
import { ApiError } from "../http/envelope";

const fold = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("pt-BR");

/** This records a clinical decision; it never establishes which thresholds a hospital should approve. */
export function assertApprovedLaboratoryReferences(template: LaboratoryPanelTemplate | undefined, snapshot: ExamDefinitionSnapshot, content: Record<string, unknown>, production = process.env.NODE_ENV === "production"): void {
  if (!production || !template || content.kind !== "LABORATORY_STRUCTURED") return;
  const approval = template.approval;
  const fail = () => { throw new ApiError("REFERENCE_POLICY_MISSING", "A referência laboratorial ainda não está homologada para o contexto deste paciente.", 422); };
  if (!approval || !approval.approvedBy || !Number.isFinite(Date.parse(approval.approvedAt)) || !approval.policyReference.trim() || !approval.population || !Array.isArray(approval.population.species) || approval.population.species.length === 0) return fail();
  const population = approval.population;
  if (!population.species.map(fold).includes(fold(snapshot.patientContext.species))) return fail();
  if (population.sex && (!snapshot.patientContext.sex || !population.sex.map(fold).includes(fold(snapshot.patientContext.sex)))) return fail();
  if (population.minAgeDays !== undefined || population.maxAgeDays !== undefined) {
    const birthDate = snapshot.patientContext.birthDate;
    if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || !Number.isFinite(Date.parse(birthDate)) || new Date(birthDate).toISOString().slice(0, 10) !== birthDate) return fail();
    const day = hospitalDateKey(snapshot.capturedAt, hospitalTimezone(process.env.APP_TIMEZONE ?? process.env.NEXT_PUBLIC_HOSPITAL_TIMEZONE));
    const ageDays = Math.floor((Date.parse(day) - Date.parse(birthDate)) / 86_400_000);
    if (!Number.isFinite(ageDays) || ageDays < 0 || population.minAgeDays !== undefined && ageDays < population.minAgeDays || population.maxAgeDays !== undefined && ageDays > population.maxAgeDays) return fail();
  }
  const observations = (content as unknown as StructuredLaboratoryResultContent).observations;
  for (const observation of observations) {
    const definition = template.analytes.find((entry) => entry.code === observation.analyteCode);
    if (definition?.valueType !== "NUMERIC") continue;
    const range = observation.referenceRange;
    if (!range || range.kind !== "NUMERIC" || range.source !== "HUMAN_APPROVED" || range.unitCode !== observation.unitCode || range.low === undefined && range.high === undefined || range.low !== undefined && !Number.isFinite(range.low) || range.high !== undefined && !Number.isFinite(range.high) || range.low !== undefined && range.high !== undefined && range.low > range.high) return fail();
  }
}
