import { isDeepStrictEqual } from "node:util";
import type { StateStore } from "../server/domain/models";
import { createExamDefinitionService } from "../server/application/exam-definition-service";
import type { ApplicationServiceContext } from "../server/application/service-context";
import { syntheticHemogramTemplate } from "../server/store/fixtures";

export const E2E_LABORATORY_POLICY_REFERENCE = "SYNTHETIC_E2E_ONLY_NOT_HOSPITAL_POLICY_V1";
export const E2E_LABORATORY_REFERENCE_NOTE = "Faixa artificial de E2E; não é uma referência clínica ou homologação hospitalar.";

export function assertE2eLaboratoryPreparationAllowed(databaseUrl: string, environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const enabled = environment.E2E_APPROVED_SYNTHETIC_LABORATORY;
  if (enabled === undefined || enabled === "false") return false;
  if (enabled !== "true" || environment.CI !== "true" || environment.ALLOW_SYNTHETIC_SEED !== "true" || !["development", "test"].includes(environment.NODE_ENV ?? "")) {
    throw new Error("A preparação laboratorial sintética exige opt-in explícito, CI e seed fora de produção.");
  }
  let target: URL;
  try { target = new URL(databaseUrl); } catch { throw new Error("A preparação laboratorial sintética exige um banco E2E descartável em loopback."); }
  const databaseName = environment.E2E_DATABASE_NAME;
  if (!databaseName || !/^cvg_test_e2e_[0-9]+$/.test(databaseName) || target.pathname !== `/${databaseName}` || !["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname.toLowerCase()) || target.search || target.hash) {
    throw new Error("A preparação laboratorial sintética exige um banco E2E descartável em loopback.");
  }
  return true;
}

export async function prepareE2eLaboratoryPolicy(store: StateStore, databaseUrl: string, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  if (!assertE2eLaboratoryPreparationAllowed(databaseUrl, environment)) throw new Error("A preparação laboratorial sintética exige opt-in explícito.");
  const state = await store.readState();
  const catalog = state.services.find((entry) => entry.id === "service-hemogram");
  const editor = state.users.find((entry) => entry.id === "user-admin" && entry.active && entry.role === "ADMIN");
  const reviewer = state.users.find((entry) => entry.id === "user-vet" && entry.active && entry.role === "VETERINARIAN");
  if (state.requests.length || state.items.length || state.results.length || !editor || !reviewer || !catalog?.active || catalog.resultSchema !== "NUMERIC_PANEL" || !isDeepStrictEqual(catalog.resultTemplate, syntheticHemogramTemplate)) {
    throw new Error("A preparação laboratorial sintética exige o seed padrão recém-criado, sem solicitações ou resultados.");
  }
  // These native catalog commands use only the store. Any accidental storage/scanner access fails closed.
  const unavailable = (): never => { throw new Error("A preparação laboratorial sintética não pode acessar armazenamento ou scanner."); };
  const context: ApplicationServiceContext = { store, get storage() { return unavailable(); }, get scanner() { return unavailable(); }, get patientDiagnosticsAuxiliaryReader() { return unavailable(); } };
  const commands = createExamDefinitionService(context);
  const template = {
    code: syntheticHemogramTemplate.code,
    name: syntheticHemogramTemplate.name,
    schemaVersion: syntheticHemogramTemplate.schemaVersion,
    analytes: syntheticHemogramTemplate.analytes.map((entry) => ({
      ...structuredClone(entry),
      ...(entry.valueType === "NUMERIC" ? { referenceRange: { kind: "NUMERIC" as const, unitCode: entry.unitCode, low: 0, high: 1_000_000, source: "PENDING_HUMAN_POLICY" as const, note: E2E_LABORATORY_REFERENCE_NOTE } } : {})
    }))
  };
  const prepared = await commands.prepareExamTemplate(editor, catalog.id, { expectedVersion: catalog.version, template, idempotencyKey: "e2e-synthetic-lab-prepare-v1" });
  await commands.publishExamTemplate(reviewer, catalog.id, { expectedVersion: prepared.version, policyReference: E2E_LABORATORY_POLICY_REFERENCE, population: { species: ["Canino", "Felino"] }, confirm: true, idempotencyKey: "e2e-synthetic-lab-publish-v1" });
}
