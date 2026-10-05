import type { OutboxMessage } from "./models";

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
  const pending = messages.filter((message) => message.status === "PENDING" || message.status === "PROCESSING");
  const oldest = pending.map((message) => Date.parse(message.availableAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return { pending: pending.length, ...(oldest === undefined ? {} : { oldestAvailableAt: new Date(oldest).toISOString() }) };
}
