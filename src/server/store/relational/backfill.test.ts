import { describe, expect, it } from "vitest";
import {
  RELATIONAL_BACKFILL_PHASES,
  RelationalBackfillMismatchError,
  RelationalBackfillPostWriteMismatchError,
  runRelationalBackfill,
  stableHash,
  type RelationalBackfillCheckpoint,
  type RelationalBackfillPhase,
  type RelationalBackfillRow
} from "./backfill";

function harness(rows: Partial<Record<RelationalBackfillPhase, RelationalBackfillRow[]>>, initial?: RelationalBackfillCheckpoint) {
  const state = new Map<RelationalBackfillPhase, RelationalBackfillRow[]>(Object.entries(rows) as Array<[RelationalBackfillPhase, RelationalBackfillRow[]]>);
  const targetRows = new Map<string, string>();
  let checkpoint = initial;
  const checkpointStore = {
      async read() { return checkpoint; },
      async write(next: RelationalBackfillCheckpoint) { checkpoint = next; }
  };
  return {
    checkpoint: checkpointStore,
    source: {
      async page(phase: RelationalBackfillPhase, afterId: string | undefined, limit: number) {
        const available = (state.get(phase) ?? []).filter((row) => afterId === undefined || row.id > afterId);
        const page = available.slice(0, limit);
        return { rows: page, done: page.length === available.length, nextCursor: page.at(-1)?.id };
      }
    },
    target: {
      async upsert(phase: RelationalBackfillPhase, row: RelationalBackfillRow) { targetRows.set(`${phase}:${row.id}`, stableHash(row.value)); },
      async hash(phase: RelationalBackfillPhase, id: string) { return targetRows.get(`${phase}:${id}`); }
    },
    get currentCheckpoint() { return checkpoint; },
    targetRows
  };
}

describe("relational backfill runner", () => {
  it("processes parents before notification deliveries and resumes from a cursor", async () => {
    const h = harness({
      notifications: [{ id: "notification-1", value: { requestId: "request-1" } }],
      notification_deliveries: [{ id: "delivery-1", value: { notificationId: "notification-1" } }]
    });
    const report = await runRelationalBackfill({ ...h, transformVersion: "v1", batchSize: 1 });
    expect(RELATIONAL_BACKFILL_PHASES.indexOf("notifications")).toBeLessThan(RELATIONAL_BACKFILL_PHASES.indexOf("notification_deliveries"));
    expect(report.counts.notifications).toBe(1);
    expect(report.counts.notification_deliveries).toBe(1);
    expect(h.currentCheckpoint?.phase).toBe("outbox_messages");
  });

  it("does not duplicate rows after an interrupted page and continues idempotently", async () => {
    const h = harness({ patients: [{ id: "patient-1", value: { name: "A" } }, { id: "patient-2", value: { name: "B" } }] });
    const controller = new AbortController();
    const originalWrite = h.checkpoint.write.bind(h.checkpoint);
    let writes = 0;
    h.checkpoint.write = async (next) => {
      await originalWrite(next);
      writes += 1;
      if (next.phase === "patients" && next.cursor === "patient-1") controller.abort();
    };
    await expect(runRelationalBackfill({ ...h, transformVersion: "v1", batchSize: 1, signal: controller.signal })).rejects.toThrow("RELATIONAL_BACKFILL_ABORTED");
    expect(h.targetRows.has("patients:patient-1")).toBe(true);
    const report = await runRelationalBackfill({ ...h, transformVersion: "v1", batchSize: 1 });
    expect(report.counts.patients).toBe(1);
    expect(h.targetRows.size).toBe(2);
  });

  it("fails closed on transform drift, unordered pages and target divergence", async () => {
    const h = harness({ patients: [{ id: "patient-1", value: { name: "A" } }] }, { transformVersion: "v0", phase: "patients" });
    await expect(runRelationalBackfill({ ...h, transformVersion: "v1" })).rejects.toThrow("RELATIONAL_BACKFILL_TRANSFORM_MISMATCH");

    const unordered = harness({ patients: [{ id: "patient-2", value: {} }, { id: "patient-1", value: {} }] });
    await expect(runRelationalBackfill({ ...unordered, transformVersion: "v1", batchSize: 2 })).rejects.toThrow("RELATIONAL_BACKFILL_PAGE_NOT_ORDERED");

    const divergent = harness({ patients: [{ id: "patient-1", value: { name: "A" } }] });
    divergent.targetRows.set("patients:patient-1", stableHash({ name: "B" }));
    await expect(runRelationalBackfill({ ...divergent, transformVersion: "v1" })).rejects.toBeInstanceOf(RelationalBackfillMismatchError);
  });

  it("verifies the target after every upsert and rejects a write that is not durable or lossless", async () => {
    const h = harness({ patients: [{ id: "patient-1", value: { name: "A" } }] });
    const originalUpsert = h.target.upsert;
    h.target.upsert = async (phase, row) => {
      await originalUpsert(phase, { ...row, value: { name: "silently-transformed" } });
    };

    await expect(runRelationalBackfill({ ...h, transformVersion: "v1" }))
      .rejects.toBeInstanceOf(RelationalBackfillPostWriteMismatchError);
  });

  it("rejects a non-progressing source page instead of looping forever", async () => {
    const h = harness({ patients: [] });
    h.source.page = async (_phase, afterId, _limit) => ({ rows: [], done: false, nextCursor: afterId });

    await expect(runRelationalBackfill({ ...h, transformVersion: "v1" }))
      .rejects.toThrow("RELATIONAL_BACKFILL_CURSOR_STALLED:departments");
  });

  it("rejects a provider cursor that skips past the last emitted row", async () => {
    const h = harness({ departments: [{ id: "department-1", value: { name: "A" } }] });
    h.source.page = async (phase, afterId, _limit) => {
      if (phase !== "departments" || afterId !== undefined) return { rows: [], done: true, nextCursor: undefined };
      return { rows: [{ id: "department-1", value: { name: "A" } }], done: false, nextCursor: "department-z" };
    };

    await expect(runRelationalBackfill({ ...h, transformVersion: "v1" }))
      .rejects.toThrow("RELATIONAL_BACKFILL_CURSOR_MISMATCH:departments");
  });
});
