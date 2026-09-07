import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Notification, StoreState } from "../domain/models";
import { createDemoState } from "./fixtures";
import { projectDurableNotificationRows } from "./postgres-notification-projection";

const timestamp = "2026-09-06T12:00:00.000Z";

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "notification-projection-test",
    category: "CRITICAL",
    priority: "URGENT",
    recipientUserId: "user-vet",
    entityType: "RESULT_VERSION",
    entityId: "result-version-projection-test",
    deepLink: "/results/result-projection-test",
    title: "Resultado crítico requer confirmação",
    body: "Notificação sintética de projeção.",
    dedupeKey: "projection-test",
    state: "PENDING",
    createdAt: timestamp,
    attempts: 0,
    version: 1,
    ...overrides
  };
}

function clientReturning(rowCount = 1) {
  const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({ rowCount, rows: [{ id: "projected" }] }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("durable notification projection seam", () => {
  it("projects the recipient before inserting a new notification", async () => {
    const before = createDemoState("postgres-projection-test-password");
    const after: StoreState = { ...before, notifications: [notification()] };
    const { client, query } = clientReturning();

    await projectDurableNotificationRows(client, before, after);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO users");
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO notifications");
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      "notification-projection-test",
      "user-vet",
      "PENDING",
      1
    ]));
  });

  it("updates an existing notification with an optimistic version and acknowledged identity", async () => {
    const before = createDemoState("postgres-projection-test-password");
    const current = notification();
    const afterNotification = notification({
      state: "ACKNOWLEDGED",
      acknowledgedAt: timestamp,
      acknowledgedBy: "user-lab",
      attempts: 1,
      version: 2
    });
    const after: StoreState = {
      ...before,
      notifications: [afterNotification],
      users: before.users
    };
    const { client, query } = clientReturning();

    await projectDurableNotificationRows(client, { ...before, notifications: [current] }, after);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO users");
    expect(query.mock.calls[2]?.[0]).toContain("UPDATE notifications");
    expect(query.mock.calls[2]?.[0]).not.toContain("updated_at");
    expect(query.mock.calls[2]?.[1]?.at(-1)).toBe(1);
  });

  it("fails closed when the notification recipient is absent", async () => {
    const before = createDemoState("postgres-projection-test-password");
    const after = {
      ...before,
      notifications: [notification({ recipientUserId: "missing-user" })]
    };
    const { client, query } = clientReturning();

    await expect(projectDurableNotificationRows(client, before, after))
      .rejects.toThrow("POSTGRES_NOTIFICATION_RECIPIENT_MISSING:notification-projection-test");
    expect(query).not.toHaveBeenCalled();
  });
});
