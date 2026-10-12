import { hospitalIntegrationHttpConfigFromEnv, postHospitalHttpsJson, type HospitalIntegrationHttpConfig } from "./hospital-integration-http";
import { hospitalAiRemoteResponseSchema } from "../http/hospital-ai-schemas";
import { ApiError } from "../http/envelope";
export interface HospitalAiHttpConfig { transport: HospitalIntegrationHttpConfig; provider: string; model: string; decisionReference: string }
export function hospitalAiHttpConfigFromEnv(environment: Partial<NodeJS.ProcessEnv> = process.env): HospitalAiHttpConfig | undefined {
  if (environment.HOSPITAL_AI_ENABLED !== "true") return undefined;
  const value = (key: string) => (environment[`HOSPITAL_AI_${key}`] ?? "").trim();
  const provider = value("PROVIDER"); const model = value("MODEL"); const decisionReference = value("DECISION_REFERENCE");
  if (!provider || provider.length > 100 || !model || model.length > 100 || !decisionReference || decisionReference.length > 500 || value("PURPOSE") !== "OPERATIONAL_DOCUMENT_TEXT") throw new ApiError("AI_CONFIGURATION_INVALID", "A assistência não possui decisão e finalidade aprovadas.", 503);
  const mapped: Partial<NodeJS.ProcessEnv> = { HOSPITAL_INTEGRATION_HIS_ENABLED: "true" };
  for (const key of ["ENDPOINT", "ALLOWED_HOSTS", "ALLOWED_IPS", "TOKEN_FILE", "HMAC_SECRET_FILE", "TIMEOUT_MS", "CA_FILE"]) mapped[`HOSPITAL_INTEGRATION_HIS_${key}`] = value(key);
  mapped.HOSPITAL_INTEGRATION_HIS_CONTRACT_REFERENCE = decisionReference;
  try { return { transport: hospitalIntegrationHttpConfigFromEnv("HIS", mapped)!, provider, model, decisionReference }; } catch { throw new ApiError("AI_CONFIGURATION_INVALID", "A assistência não possui configuração aprovada válida.", 503); }
}
export async function sendHospitalAiHttp(config: HospitalAiHttpConfig, envelope: { contract: "CVG_DOCUMENT_ASSISTANCE_V1"; messageId: string; [key: string]: unknown }) {
  const value = await postHospitalHttpsJson(config.transport, envelope, { maxResponseBytes: 250_000 }); const parsed = hospitalAiRemoteResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.messageId !== envelope.messageId || parsed.data.model !== config.model) throw new ApiError("AI_RESPONSE_INVALID", "O provedor não retornou recibo e conteúdo válidos para o modelo configurado.", 502);
  return parsed.data;
}
