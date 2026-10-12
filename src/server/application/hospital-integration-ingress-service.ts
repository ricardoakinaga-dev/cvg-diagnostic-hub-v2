import type { HospitalIntegrationMessage, HospitalIntegrationReceipt, HospitalIntegrationSystem } from "@cvg/contracts";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { hospitalIntegrationMessageSchema } from "../http/hospital-integration-schemas";
import { authorizeInboundIntegration, configuredIntegration, currentIntegrationCredential, integrationDigest, integrationReceipt } from "./hospital-integration-policy";
import { verifyHospitalIntegrationSignature } from "./hospital-integration-http";
import type { HospitalIntegrationDependencies } from "./hospital-integration-credential-service";
import { hospitalIntegrationHttpConfigFromEnv } from "./hospital-integration-http";
import { createAudit, id, now } from "./service-common";
import { createHospitalIntakeService } from "./hospital-intake-service";
import { createResultService } from "./result-service";
import { transactionalServiceContext } from "./transactional-service-context";

export function assertIntegrationSequence(messages: HospitalIntegrationMessage[], system: HospitalIntegrationSystem, direction: "INBOUND" | "OUTBOUND", externalEntityId: string, sequence: number): void {
  const previous = messages.filter((entry) => entry.system === system && entry.direction === direction && entry.externalEntityId === externalEntityId && entry.status === "SUCCEEDED");
  const last = Math.max(0, ...previous.map((entry) => entry.sequence));
  if (sequence !== last + 1) throw new ApiError("INTEGRATION_SEQUENCE_CONFLICT", "A sequência externa exige conciliar a mensagem anterior antes de continuar.", 409);
  if (messages.some((entry) => entry.system === system && entry.direction === direction && entry.externalEntityId === externalEntityId && entry.sequence === sequence )) throw new ApiError("INTEGRATION_IN_PROGRESS", "A mensagem anterior ainda está em processamento.", 409);
}
export function createHospitalIntegrationIngressService(context: ApplicationServiceContext, dependencies: HospitalIntegrationDependencies = {}) {
  const loader = dependencies.config ?? hospitalIntegrationHttpConfigFromEnv;
  return {
    async receiveHospitalIntegrationMessage(system: HospitalIntegrationSystem, token: string, signature: string, rawBody: string, correlationId?: string): Promise<HospitalIntegrationReceipt> {
      if (Buffer.byteLength(rawBody) > 2_000_000) throw new ApiError("PAYLOAD_TOO_LARGE", "A mensagem excede o limite permitido.", 413);
      const config = configuredIntegration(system, loader);
      if (!verifyHospitalIntegrationSignature(rawBody, signature, config.hmacSecret)) throw new ApiError("INTEGRATION_SIGNATURE_INVALID", "A assinatura da mensagem não é válida.", 401);
      let depth = 0; let insideString = false; let escaped = false;
      for (const character of rawBody) { if (insideString) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') insideString = false; } else if (character === '"') insideString = true; else if (character === "{" || character === "[") { if (++depth > 32) throw new ApiError("VALIDATION_ERROR", "A mensagem excede a profundidade permitida.", 400); } else if (character === "}" || character === "]") depth--; }
      let value: unknown; try { value = JSON.parse(rawBody); } catch { throw new ApiError("INVALID_JSON", "Informe uma mensagem JSON válida.", 400); }
      const parsed = hospitalIntegrationMessageSchema.safeParse(value); if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "A mensagem não segue o contrato CVG adotado.", 400);
      const body = parsed.data; const hash = integrationDigest(body);
      const outcome = await context.store.transaction<{ receipt?: HospitalIntegrationReceipt; error?: ApiError }>(async (state, audit) => {
        const { credential, actor } = currentIntegrationCredential(state, system, token); authorizeInboundIntegration(state, actor, credential, body);
        const previous = state.hospitalIntegrationMessages.find((entry) => entry.system === system && entry.direction === "INBOUND" && entry.messageId === body.messageId);
        if (previous && (previous.payloadHash !== hash || previous.actorUserId !== actor.id || previous.purpose !== body.purpose)) throw new ApiError("INTEGRATION_MESSAGE_CONFLICT", "O identificador já foi usado por outra mensagem ou outro ator.", 409);
        if (previous?.status === "SUCCEEDED") return { state, result: { receipt: integrationReceipt(previous) } };
        assertIntegrationSequence(state.hospitalIntegrationMessages.filter((entry) => entry.id !== previous?.id), system, "INBOUND", body.externalEntityId, body.sequence);
        const timestamp = now(); const message: HospitalIntegrationMessage = { id: previous?.id ?? id("integration-message"), messageId: body.messageId, system, purpose: body.purpose, externalEntityId: body.externalEntityId, sequence: body.sequence, direction: "INBOUND", status: "CLAIMED", attempts: (previous?.attempts ?? 0) + 1, retryable: false, createdAt: previous?.createdAt ?? timestamp, version: (previous?.version ?? 0) + 1, credentialId: credential.id, actorUserId: actor.id, payloadHash: hash, correlationId: correlationId ?? id("corr") };
        const tx = transactionalServiceContext(context, state, audit);
        let targetId: string; let targetType: HospitalIntegrationMessage["targetType"];
        try {
          const commandKey = `integration:${system}:${body.messageId}`;
          if (body.purpose === "HIS_INTAKE") { const result = await createHospitalIntakeService(tx.context).createHospitalIntake(actor, { ...body.payload, source: "MANUAL", sourceLabel: `CVG_OPERATIONAL_V1:${system}`, idempotencyKey: commandKey, correlationId: message.correlationId }); targetId = result.id; targetType = "HOSPITAL_INTAKE"; }
          else { const result = await createResultService(tx.context).createResultDraft(actor, body.payload.itemId, { ...body.payload.draft, idempotencyKey: commandKey, correlationId: message.correlationId }); targetId = result.result.id; targetType = "RESULT"; }
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          const failed: HospitalIntegrationMessage = { ...message, status: "FAILED", errorCode: error.code, retryable: [409, 422, 503].includes(error.status), completedAt: timestamp };
          const next = { ...state, hospitalIntegrationMessages: [...state.hospitalIntegrationMessages.filter((entry) => entry.id !== failed.id), failed] };
          return { state: next, result: { error: new ApiError(error.code, "O comando nativo recusou a mensagem; concilie o estado e tente novamente.", error.status) } };
        }
        await dependencies.afterInboundCommand?.();
        const completed: HospitalIntegrationMessage = { ...message, status: "SUCCEEDED", targetId, targetType, completedAt: now() };
        const changed = tx.state(); const next = { ...changed, hospitalIntegrationCredentials: changed.hospitalIntegrationCredentials.map((entry) => entry.id === credential.id ? { ...entry, lastUsedAt: timestamp } : entry), hospitalIntegrationMessages: [...changed.hospitalIntegrationMessages.filter((entry) => entry.id !== completed.id), completed], auditEvents: [...changed.auditEvents, createAudit("HospitalIntegrationReceived", actor.id, "HospitalIntegrationMessage", completed.id, message.correlationId, previous?.status, "SUCCEEDED", { system, purpose: body.purpose, messageId: body.messageId, sequence: body.sequence, targetType, targetId, payloadHash: hash })] };
        return { state: next, result: { receipt: integrationReceipt(completed) } };
      });
      if (outcome.error) throw outcome.error;
      return outcome.receipt!;
    }
  };
}
