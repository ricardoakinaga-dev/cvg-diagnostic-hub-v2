import { outboxEnvelopeFor, type OutboxMessage } from "./models";

/**
 * Domain events have no consumer in the outbox worker (the durable sink only
 * delivers notifications); they exist as realtime replay history. They are
 * settled as written: never pending work, and pruned like processed messages.
 * Counting them as pending made outbox_pending grow forever.
 */
export function outboxMessageSettled(message: OutboxMessage): boolean {
  if (message.status === "PROCESSED") return true;
  return message.status === "PENDING" && consumerTypeOf(message) === "DOMAIN_EVENT";
}

export function outboxMessageAwaitsDelivery(message: OutboxMessage): boolean {
  return (message.status === "PENDING" || message.status === "PROCESSING") && consumerTypeOf(message) === "NOTIFICATION_DELIVERY";
}

function consumerTypeOf(message: OutboxMessage): string {
  try {
    return outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey).consumerType;
  } catch {
    // An unroutable message is never silently dropped: it stays visible as pending work.
    return "NOTIFICATION_DELIVERY";
  }
}

export function outboxReadLimit(value: number, maximum = 100): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("OUTBOX_READ_LIMIT_INVALID");
  return Math.min(value, maximum);
}

export function outboxPage(messages: OutboxMessage[], query: { kind: "replay" | "dead-letter"; limit: number }): OutboxMessage[] {
  const limit = outboxReadLimit(query.limit);
  if (query.kind === "replay") return messages.filter((message) => message.status === "PENDING" || message.status === "PROCESSED").slice(-limit);
  return messages.filter((message) => message.status === "FAILED" || message.status === "DISCARDED")
    .sort((left, right) => (right.deadLetteredAt ?? right.availableAt).localeCompare(left.deadLetteredAt ?? left.availableAt)).slice(0, limit);
}

export function outboxMetrics(messages: OutboxMessage[]): { pending: number; oldestAvailableAt?: string } {
  const pending = messages.filter(outboxMessageAwaitsDelivery);
  const oldest = pending.map((message) => Date.parse(message.availableAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return { pending: pending.length, ...(oldest === undefined ? {} : { oldestAvailableAt: new Date(oldest).toISOString() }) };
}
