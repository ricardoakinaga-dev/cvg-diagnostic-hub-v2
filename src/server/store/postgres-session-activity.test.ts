import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  deletePostgresProcessedOutbox,
  prunePostgresSessionActivity,
  touchPostgresSessionActivity
} from "./postgres-session-activity";

function clientReturning(rowCount: number | null, rows: Record<string, unknown>[] = [{ removed: "3" }]) {
  const queries: { text: string; values: unknown[] }[] = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values: values ?? [] });
      return { rows, rowCount };
    }
  } as unknown as PoolClient;
  return { client, queries };
}

describe("retention SQL seam", () => {
  it("uses an atomic maximum for activity and returns the persisted timestamp", async () => {
    const latest = "2026-10-03T12:00:02.000Z";
    const { client, queries } = clientReturning(1, [{ session_id: "session-1", user_id: "user-vet", last_seen_at: latest }]);
    expect(await touchPostgresSessionActivity(client, { sessionId: "session-1", userId: "user-vet" }, "2026-10-03T12:00:01.000Z"))
      .toEqual({ sessionId: "session-1", userId: "user-vet", lastSeenAt: latest });
    expect(queries[0]?.text).toMatch(/last_seen_at = GREATEST\(session_activity.last_seen_at, EXCLUDED.last_seen_at\)/);
    expect(queries[0]?.values).toEqual(["session-1", "user-vet", "2026-10-03T12:00:01.000Z"]);
  });

  it("prunes activity rows the snapshot no longer knows about", async () => {
    const { client, queries } = clientReturning(1);

    expect(await prunePostgresSessionActivity(client, ["session-1", "session-2"])).toBe(3);
    expect(queries[0]?.text).toMatch(/DELETE FROM session_activity/);
    expect(queries[0]?.text).toMatch(/NOT \(session_id = ANY \(\$1::text\[\]\)\)/);
    expect(queries[0]?.values).toEqual([["session-1", "session-2"]]);
  });

  it("reads a malformed removal count as zero instead of trusting it", async () => {
    const missing = clientReturning(1, []);
    expect(await prunePostgresSessionActivity(missing.client, [])).toBe(0);

    const negative = clientReturning(1, [{ removed: "-4" }]);
    expect(await prunePostgresSessionActivity(negative.client, [])).toBe(0);

    const numeric = clientReturning(1, [{ removed: 7 }]);
    expect(await prunePostgresSessionActivity(numeric.client, [])).toBe(7);
  });

  it("deletes only processed outbox rows, and nothing for an empty list", async () => {
    const empty = clientReturning(1);
    expect(await deletePostgresProcessedOutbox(empty.client, [])).toBe(0);
    expect(empty.queries).toHaveLength(0);

    const pruned = clientReturning(2);
    expect(await deletePostgresProcessedOutbox(pruned.client, ["outbox-1", "outbox-2"])).toBe(2);
    expect(pruned.queries[0]?.text).toMatch(/DELETE FROM outbox_messages WHERE id = ANY\(\$1::text\[\]\) AND status = 'PROCESSED'/);
    expect(pruned.queries[0]?.values).toEqual([["outbox-1", "outbox-2"]]);

    const unknown = clientReturning(null);
    expect(await deletePostgresProcessedOutbox(unknown.client, ["outbox-3"])).toBe(0);
  });
});
