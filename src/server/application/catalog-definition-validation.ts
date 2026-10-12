import type { DiagnosticService, WorkflowType } from "@cvg/contracts";
import { ApiError } from "../http/envelope";

export function validateServiceDefinition(category: DiagnosticService["category"], workflowType: WorkflowType): void {
  const valid = (category === "LABORATORY" && workflowType === "LABORATORY") || (category === "IMAGING" && ["RADIOLOGY", "ULTRASOUND"].includes(workflowType));
  if (!valid) throw new ApiError("VALIDATION_ERROR", "Categoria e workflow do serviço não são compatíveis.", 400);
}

export function validateServiceResultSchema(
  category: DiagnosticService["category"],
  workflowType: WorkflowType,
  resultSchema: DiagnosticService["resultSchema"],
  resultTemplate?: DiagnosticService["resultTemplate"],
  options: { allowUnpublished?: boolean } = {}
): void {
  if (resultSchema !== "NUMERIC_PANEL") return;
  if (category !== "LABORATORY" || workflowType !== "LABORATORY" || !(resultTemplate?.status === "ACTIVE" || (options.allowUnpublished && resultTemplate && ["DRAFT", "RETIRED"].includes(resultTemplate.status)))) {
    throw new ApiError("VALIDATION_ERROR", "Um painel numérico exige um template laboratorial ativo e versionado.", 422);
  }
}
