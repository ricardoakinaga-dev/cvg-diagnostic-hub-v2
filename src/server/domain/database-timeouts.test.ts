import { createServer, type AddressInfo, type Socket } from "node:net";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runtimePoolTimeouts } from "./database-timeouts";

describe("runtime PostgreSQL pool timeouts", () => {
  it("uses bounded defaults and honours valid overrides", () => {
    expect(runtimePoolTimeouts({})).toEqual({ connectionTimeoutMillis: 5_000, statement_timeout: 30_000, query_timeout: 35_000, idle_in_transaction_session_timeout: 60_000 });
    expect(runtimePoolTimeouts({ DB_CONNECT_TIMEOUT_MS: "2000", DB_STATEMENT_TIMEOUT_MS: "10000", DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "20000" }))
      .toEqual({ connectionTimeoutMillis: 2_000, statement_timeout: 10_000, query_timeout: 15_000, idle_in_transaction_session_timeout: 20_000 });
    for (const malformed of ["", "abc", "0", "-1", "1.5"]) expect(runtimePoolTimeouts({ DB_STATEMENT_TIMEOUT_MS: malformed }).statement_timeout).toBe(30_000);
    expect(runtimePoolTimeouts({ DB_CONNECT_TIMEOUT_MS: "1", DB_STATEMENT_TIMEOUT_MS: "99999999" })).toMatchObject({ connectionTimeoutMillis: 500, statement_timeout: 600_000 });
  });

  it("fails a query instead of hanging when the server accepts the socket but never answers", async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const pool = new Pool({ host: "127.0.0.1", port, user: "x", database: "x", password: "x", max: 1, ...runtimePoolTimeouts({ DB_CONNECT_TIMEOUT_MS: "500" }) });
    pool.on("error", () => undefined);
    try {
      const startedAt = Date.now();
      await expect(pool.query("SELECT 1")).rejects.toThrow(/timeout/i);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await pool.end().catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
