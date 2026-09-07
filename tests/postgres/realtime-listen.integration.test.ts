import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresListenRealtimeNotificationAdapter,
  type RealtimeNotificationPool
} from "../../src/server/observability/realtime";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const CHANNEL = "cvg_realtime_listen_integration";
const WAKEUP_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 40;

describe("PostgreSQL LISTEN/NOTIFY realtime integration", () => {
  it("wakes a subscriber adapter through a separate PostgreSQL pool", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const publisherPool = new Pool({
        connectionString: database.connectionString(),
        application_name: "cvg-realtime-publisher-test",
        max: 1
      });
      const subscriberPool = new Pool({
        connectionString: database.connectionString(),
        application_name: "cvg-realtime-subscriber-test",
        max: 1
      });
      publisherPool.on("error", () => undefined);
      subscriberPool.on("error", () => undefined);

      const publisher = new PostgresListenRealtimeNotificationAdapter(
        publisherPool as unknown as RealtimeNotificationPool,
        CHANNEL
      );
      const subscriber = new PostgresListenRealtimeNotificationAdapter(
        subscriberPool as unknown as RealtimeNotificationPool,
        CHANNEL
      );
      let unsubscribe: () => void = () => undefined;
      let retryTimer: ReturnType<typeof setInterval> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let wakeupCount = 0;

      try {
        const wakeup = new Promise<void>((resolve, reject) => {
          unsubscribe = subscriber.subscribe(() => {
            wakeupCount += 1;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            resolve();
          });
          timeoutTimer = setTimeout(() => {
            unsubscribe();
            reject(new Error("Timed out waiting for PostgreSQL LISTEN/NOTIFY wake-up."));
          }, WAKEUP_TIMEOUT_MS);
        });

        // LISTEN is established asynchronously; retries make the test tolerant
        // of a publish that races the subscriber's dedicated connection setup.
        retryTimer = setInterval(() => publisher.notify(), RETRY_INTERVAL_MS);
        publisher.notify();
        await wakeup;

        expect(publisher.scope).toBe("multi-instance");
        expect(subscriber.scope).toBe("multi-instance");
        expect(wakeupCount).toBeGreaterThanOrEqual(1);
      } finally {
        if (retryTimer) clearInterval(retryTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unsubscribe();
        await subscriber.close();
        await publisher.close();
      }
    });
  });
});
