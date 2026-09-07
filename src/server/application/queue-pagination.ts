import { decodeKeysetCursor } from "./service-common";

export interface QueueCursor {
  priorityRank: number;
  dueAt: string;
  id: string;
}

export function decodeQueueCursor(cursor: string | undefined): QueueCursor | undefined {
  return decodeKeysetCursor<QueueCursor>(cursor, (value) => Number.isSafeInteger(value.priorityRank) && Number(value.priorityRank) >= 0 && Number(value.priorityRank) <= 2 && typeof value.dueAt === "string" && !Number.isNaN(Date.parse(value.dueAt)) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200);
}

export function encodeQueueCursor(value: QueueCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
