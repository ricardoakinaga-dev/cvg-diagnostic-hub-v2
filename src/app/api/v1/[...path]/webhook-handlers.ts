import { recordWhatsAppStatuses } from "../../../../server/application/whatsapp-delivery-status";
import { ApiError } from "../../../../server/http/envelope";
import { readBytesWithLimit } from "../../../../server/http/request-body";
import { parseWhatsAppStatusUpdates, verifyWhatsAppSignature, verifyWhatsAppSubscription } from "../../../../server/operations/whatsapp-cloud-api";
import { getRuntimeStoreAsync } from "../../../../server/store/runtime";
import { assertHealthRateLimit, positiveInteger, responseFor } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";

/** PROD-402: the webhook exists only when the channel is on and both Meta secrets are configured. */
function webhookSecrets(): { appSecret: string; verifyToken: string } {
  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim() ?? "";
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
  if (process.env.WHATSAPP_ENABLED !== "true" || !appSecret || !verifyToken) throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
  return { appSecret, verifyToken };
}

async function assertWebhookRateLimit(clientKey: string): Promise<void> {
  await assertHealthRateLimit(`whatsapp-webhook:${clientKey}`, positiveInteger(process.env.WHATSAPP_WEBHOOK_RATE_LIMIT, 600));
}

export const webhookHandlers = {
  verifyWhatsAppWebhook: { authentication: "public", handle: async ({ request, correlationId, rateLimitClientKey }) => {
      const { verifyToken } = webhookSecrets();
      await assertWebhookRateLimit(rateLimitClientKey);
      const challenge = verifyWhatsAppSubscription(new URL(request.url).searchParams, verifyToken);
      if (!challenge)
        throw new ApiError("WEBHOOK_VERIFICATION_FAILED", "A verificação do webhook foi recusada.", 403);
      return new Response(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-correlation-id": correlationId } });
    } },
  receiveWhatsAppStatus: { authentication: "public", handle: async ({ request, correlationId, id, rateLimitClientKey }) => {
      const { appSecret } = webhookSecrets();
      await assertWebhookRateLimit(rateLimitClientKey);
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
        throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "O corpo da requisição deve usar application/json.", 415);
      // The signature covers the exact bytes Meta sent, so they are read once and verified before parsing.
      const bytes = await readBytesWithLimit(request, positiveInteger(process.env.WHATSAPP_WEBHOOK_MAX_BYTES, 256 * 1024));
      if (!verifyWhatsAppSignature(bytes, request.headers.get("x-hub-signature-256"), appSecret))
        throw new ApiError("WEBHOOK_SIGNATURE_INVALID", "A assinatura do webhook é inválida.", 401);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      }
      catch {
        throw new ApiError("VALIDATION_ERROR", "O corpo JSON da requisição é inválido.", 400);
      }
      const updates = parseWhatsAppStatusUpdates(payload);
      const applied = await recordWhatsAppStatuses(await getRuntimeStoreAsync(), updates, correlationId);
      return responseFor({ received: updates.length, applied }, correlationId, id);
    } }
} satisfies ApiHandlerGroup;
