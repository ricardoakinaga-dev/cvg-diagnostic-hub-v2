import { z } from "zod";
import type { HospitalIntakeOptions, HospitalIntakeReasonSnapshot } from "@cvg/contracts";
import { ApiError } from "../http/envelope";

const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,59}$/);
const policySchema = z.object({
  version: z.string().trim().min(1).max(100), approvedAt: z.iso.datetime({ offset: true }),
  approvalReference: z.string().trim().min(1).max(500),
  departmentCodes: z.array(code).min(1).max(100).refine((values) => new Set(values).size === values.length),
  reasons: z.array(z.object({ code, label: z.string().trim().min(1).max(500) }).strict()).min(1).max(100),
  defaultReasonCode: code.optional()
}).strict().refine((policy) => new Set(policy.reasons.map((reason) => reason.code)).size === policy.reasons.length && (!policy.defaultReasonCode || policy.reasons.some((reason) => reason.code === policy.defaultReasonCode)) && Date.parse(policy.approvedAt) <= Date.now());

/** Absent or invalid approval never supplies a preset; manual reasons remain available. */
export function intakeRejectionPolicyFromEnvironment(environment: Partial<NodeJS.ProcessEnv> = process.env): HospitalIntakeOptions {
  const source = environment.HOSPITAL_INTAKE_REJECTION_POLICY_JSON?.trim();
  if (!source) return { rejectionPolicyStatus: "OFF" };
  try {
    const parsed = policySchema.safeParse(JSON.parse(source));
    return parsed.success ? { rejectionPolicyStatus: "AVAILABLE", rejectionPolicy: parsed.data } : { rejectionPolicyStatus: "INVALID" };
  } catch { return { rejectionPolicyStatus: "INVALID" }; }
}

export function approvedIntakeRejectionReason(departmentCode: string, reasonCode?: string, policyVersion?: string): HospitalIntakeReasonSnapshot | undefined {
  if (!reasonCode) return undefined;
  const { rejectionPolicy } = intakeRejectionPolicyFromEnvironment();
  if (!rejectionPolicy || !rejectionPolicy.departmentCodes.includes(departmentCode)) throw new ApiError("INTAKE_REJECTION_POLICY_UNAVAILABLE", "O motivo aprovado não está disponível neste setor. Atualize a política ou informe um motivo próprio.", 409);
  if (rejectionPolicy.version !== policyVersion) throw new ApiError("INTAKE_REJECTION_POLICY_CHANGED", "A política de rejeição foi alterada. Atualize os motivos antes de confirmar.", 409);
  const reason = rejectionPolicy.reasons.find((entry) => entry.code === reasonCode);
  if (!reason) throw new ApiError("VALIDATION_ERROR", "Selecione um motivo pertencente à política aprovada atual.", 400);
  return { ...reason, policyVersion: rejectionPolicy.version, approvedAt: rejectionPolicy.approvedAt, approvalReference: rejectionPolicy.approvalReference };
}
