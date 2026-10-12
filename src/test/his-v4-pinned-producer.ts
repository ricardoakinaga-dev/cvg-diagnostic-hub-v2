import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { Script } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import source from "./his-v4-pinned-producer-source.json";
import { EXTERNAL_SECRET } from "./hospital-external-fixtures";
import { hisV4Event } from "./hospital-his-v4-fixtures";
import type { HospitalHisV4Headers } from "../server/http/hospital-his-v4-schemas";

type RecordValue = Record<string, unknown>;
type NativeEvent = ReturnType<typeof hisV4Event> & { data: ReturnType<typeof hisV4Event>["data"] & { _meta: RecordValue } };
interface NativeRequest { headers: Record<string, string>; body: string }
interface NativeDelivery { payload: NativeEvent; event: string; id: string }
const pinnedCommit = "0ebfc5b6627c8ed006075dc5285fd3514443c806";

/** Execute only the reviewed pure source fragments; imports other than the two pure envelope modules fail closed. */
function evaluate(code: string, bindings: RecordValue = {}, imports: Record<string, RecordValue> = {}): RecordValue {
  const exports: RecordValue = {};
  const output = transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } }).outputText;
  new Script(output).runInNewContext({ exports, Date, URL, Buffer, ...bindings, require: (name: string) => {
    if (!Object.hasOwn(imports, name)) throw new Error(`UNEXPECTED_PINNED_SOURCE_IMPORT:${name}`);
    return imports[name];
  } }, { timeout: 1000 });
  return exports;
}

function fragment(name: keyof typeof source.fragments): string {
  const record = source.fragments[name];
  if (source.commit !== pinnedCommit || source.previousCommit !== "272581dc60b764a8fee78108110dc7e465f62542"
    || !record.sameFragmentAcrossPinnedCommits || record.fragmentSha256 !== record.previousCommitFragmentSha256
    || createHash("sha256").update(record.code).digest("hex") !== record.fragmentSha256) throw new Error(`PINNED_HIS_FRAGMENT_CHANGED:${record.path}`);
  return record.code;
}

/**
 * Actual pinned runtime callback → publish → consumer → enqueue → delivery bodies.
 * Only repositories, tenant/tracing context and DNS/HTTP transports are memory substitutes.
 * This is a synthetic producer-contract proof, never an installed HIS or network proof.
 */
export async function producePinnedHisV4Webhook(options: { trace?: boolean; tenant?: boolean; correlationId?: string } = {}) {
  const sharedEnvelope = evaluate(fragment("sharedEnvelope"));
  const eventCatalog = evaluate(fragment("eventCatalog"));
  const envelope = evaluate(fragment("eventEnvelope"), {}, {
    "@cvg-his-v2/shared-types": sharedEnvelope, "./event-catalog.js": eventCatalog
  });
  const utils = evaluate([fragment("correlationEntropy"), fragment("nowIso"), fragment("createCorrelationId")].join("\n"), { randomBytes });
  const business = hisV4Event().data;
  const tenantContext = { accountId: business.accountId, correlationId: options.correlationId ?? "his_meta_correlation_synthetic", ...(options.tenant === false ? {} : { tenantId: "his_meta_tenant_synthetic" }) };
  const outbox: RecordValue[] = [];
  const Bus = evaluate(`export class PinnedBus { #repository; constructor(repository) { this.#repository=repository; } ${fragment("eventBusPublish")} }`, {
    randomUUID, nowIso: utils.nowIso, buildEventEnvelopeMetadata: envelope.buildEventEnvelopeMetadata,
    mergeEventEnvelopeMetadata: sharedEnvelope.mergeEventEnvelopeMetadata, getTenantContext: () => tenantContext
  }).PinnedBus as new (repository: { create: (event: RecordValue) => Promise<void> }) => { publish: (input: RecordValue) => Promise<RecordValue> };
  const bus = new Bus({ create: async event => { outbox.push(JSON.parse(JSON.stringify(event))); } });
  const span = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
  const runtime = evaluate(`${fragment("runtimePublishEvent")}\nexports.publishEvent=publishEvent;`, {
    eventBus: bus, getTenantContext: () => tenantContext, createCorrelationId: utils.createCorrelationId, nowIso: utils.nowIso,
    otelTrace: { getActiveSpan: () => options.trace === false ? undefined : { spanContext: () => span }, isSpanContextValid: () => true }
  });
  const Runtime = evaluate(`export class PinnedRuntime { ${fragment("runtimeOnEncounterCreated")} }`, {
    publishEvent: runtime.publishEvent
  }).PinnedRuntime as new () => { onEncounterCreated: (encounter: typeof business) => Promise<void> };
  await new Runtime().onEncounterCreated(business);
  if (outbox.length !== 1) throw new Error("PINNED_HIS_OUTBOX_NOT_CREATED");

  const validation = evaluate(fragment("requireNonEmptyString"), { ValidationError: Error });
  const webhookHelpers = evaluate([
    fragment("webhookAddressBlockList"), fragment("webhookIpv4BlockList"), fragment("webhookIpv6BlockList"),
    fragment("webhookPrivateAddress"), fragment("webhookNormalizeUrl"), fragment("webhookSignature"), fragment("webhookSignatureVersion"),
    "exports.normalizeWebhookUrl=normalizeWebhookUrl; exports.isPrivateAddress=isPrivateAddress;"
  ].join("\n"), { BlockList, isIP, createHmac, requireNonEmptyString: validation.requireNonEmptyString });
  const webhook = { id: "wh_synthetic", url: "https://receiver.example.test/his", secret: EXTERNAL_SECRET };
  const deliveries: NativeDelivery[] = [];
  let captured: NativeRequest | undefined;
  const Webhooks = evaluate(`export class PinnedWebhooks {
    #repository; #resolveHostname; #deliverRequest;
    constructor(repository, deliverRequest) { this.#repository=repository; this.#resolveHostname=async()=>["93.184.216.34"]; this.#deliverRequest=deliverRequest; }
    ${fragment("webhookEnqueue")}
    ${fragment("webhookAttemptDelivery")}
    async attempt(webhook, payload, delivery) { return this.#attemptDelivery(webhook,payload,delivery); }
  }`, { nowIso: utils.nowIso, createCorrelationId: utils.createCorrelationId, ...webhookHelpers }).PinnedWebhooks as new (
    repository: { findActiveByEvent: () => Promise<typeof webhook[]>; createDelivery: (delivery: NativeDelivery) => Promise<void> },
    deliverRequest: (request: NativeRequest) => Promise<{ success: boolean }>
  ) => { enqueue: (accountId: string, event: string, payload: RecordValue) => Promise<number>; attempt: (target: typeof webhook, payload: NativeEvent, delivery: NativeDelivery) => Promise<{ success: boolean }> };
  const webhooks = new Webhooks({ findActiveByEvent: async () => [webhook], createDelivery: async delivery => { deliveries.push(JSON.parse(JSON.stringify(delivery))); } }, async request => {
    captured = request; return { success: true };
  });
  const Consumer = evaluate(fragment("consumer")).WebhooksEventHandlers as new (options: { webhooks: typeof webhooks }) => { handle: (event: RecordValue) => Promise<void> };
  await new Consumer({ webhooks }).handle(outbox[0]);
  if (deliveries.length !== 1 || !(await webhooks.attempt(webhook, deliveries[0].payload, deliveries[0])).success || !captured) throw new Error("PINNED_HIS_WEBHOOK_NOT_EMITTED");
  const request = captured as NativeRequest;
  const headers: HospitalHisV4Headers = {
    signature: request.headers["X-Webhook-Signature"], timestamp: request.headers["X-Webhook-Timestamp"],
    signatureVersion: request.headers["X-Webhook-Signature-Version"], webhookId: request.headers["X-Webhook-ID"],
    deliveryId: request.headers["X-Webhook-Delivery-ID"], event: request.headers["X-Webhook-Event"], idempotencyKey: request.headers["Idempotency-Key"]
  };
  if (Object.values(headers).some(value => typeof value !== "string") || Object.keys(request.headers).length !== 8) throw new Error("PINNED_HIS_HEADERS_NOT_EMITTED");
  return { event: JSON.parse(request.body) as NativeEvent, rawBody: request.body, headers, nativeHeaders: request.headers, outboxEvent: outbox[0], provenance: {
    commit: source.commit, previousCommit: source.previousCommit,
    fragments: Object.entries(source.fragments).map(([name, { code: _code, ...record }]) => ({ name, ...record })),
    scope: "Exact source bodies with memory persistence and transport; no installed HIS, environment, database or network"
  } };
}
