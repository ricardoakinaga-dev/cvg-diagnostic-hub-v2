import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { renderPrometheus, resetMetrics } from "../observability/metrics";
import * as structuredLogger from "../observability/structured-logger";
import { assertLoginAttempt, registerLoginFailure, resetRateLimits } from "./rate-limit";
import * as rateLimit from "./rate-limit";
import { loginUser } from "./session";
import { observeLoginFailure, pseudonymousAccountId, registerAccountLoginFailure, reportDistributedAttempts } from "./login-signal";

const ENV = { SESSION_SECRET: "s".repeat(32), LOGIN_ACCOUNT_SIGNAL_THRESHOLD: "4", LOGIN_ACCOUNT_SIGNAL_WINDOW_MS: "60000" };
const email = "Vet@cvg.local";

describe("aggregated per-account login signal (PROD-203 / PROD-517)", () => {
  beforeEach(() => { resetRateLimits(); resetMetrics(); });
  afterEach(() => vi.restoreAllMocks());

  it("derives a stable pseudonymous id that does not contain the e-mail and depends on the secret", () => {
    const id = pseudonymousAccountId(email, ENV);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(pseudonymousAccountId(" vet@CVG.local ", ENV)).toBe(id);
    expect(pseudonymousAccountId(email, { SESSION_SECRET: "t".repeat(32) })).not.toBe(id);
    expect(pseudonymousAccountId(email, {})).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain("vet");
  });

  it("fires exactly once per window, when the count reaches the threshold, with the distinct client count", async () => {
    const signals = [];
    const clients = ["a", "b", "a", "c", "d", "e", "f"];
    for (const [index, clientKey] of clients.entries()) {
      signals.push(await registerAccountLoginFailure({ email, clientKey }, ENV, 1_000 + index));
    }
    expect(signals.filter(Boolean)).toHaveLength(1);
    expect(signals[3]).toEqual({ accountId: pseudonymousAccountId(email, ENV), attempts: 4, distinctClients: 3, windowMs: 60000, threshold: 4 });
    expect(signals.slice(0, 3).every((signal) => signal === undefined)).toBe(true);
    expect(signals.slice(4).every((signal) => signal === undefined)).toBe(true);
  });

  it("re-arms after the window and keeps accounts independent", async () => {
    const fire = async (clientKey: string, at: number, account = email) => registerAccountLoginFailure({ email: account, clientKey }, ENV, at);
    for (let i = 0; i < 3; i += 1) await fire(`c${i}`, 1000 + i);
    expect(await fire("c3", 1004)).toMatchObject({ attempts: 4 });
    for (let i = 0; i < 4; i += 1) expect(await fire(`other${i}`, 2000 + i, "lab@cvg.local")).toEqual(i === 3 ? expect.objectContaining({ attempts: 4 }) : undefined);
    // A new window starts after 60 s.
    const later = 1000 + 61_000;
    for (let i = 0; i < 3; i += 1) expect(await fire(`n${i}`, later + i)).toBeUndefined();
    expect(await fire("n3", later + 3)).toMatchObject({ attempts: 4, distinctClients: 4 });
  });

  it("uses safe defaults for invalid configuration (20 attempts / 15 minutes)", async () => {
    let fired;
    for (let i = 0; i < 20; i += 1) fired = await registerAccountLoginFailure({ email, clientKey: "same" }, { LOGIN_ACCOUNT_SIGNAL_THRESHOLD: "0", LOGIN_ACCOUNT_SIGNAL_WINDOW_MS: "abc" }, 5_000 + i);
    expect(fired).toMatchObject({ attempts: 20, distinctClients: 1, windowMs: 15 * 60 * 1000, threshold: 20 });
  });

  it("reports through log, counter and audit event without blocking anything", async () => {
    const warn = vi.fn();
    vi.spyOn(structuredLogger, "createStructuredLogger").mockReturnValue({ warn } as unknown as ReturnType<typeof structuredLogger.createStructuredLogger>);
    const store = new MemoryStore(createDemoState("Initial-secret-1234"));
    const signal = { accountId: "0123456789abcdef", attempts: 20, distinctClients: 7, windowMs: 900000, threshold: 20 };

    await reportDistributedAttempts(store, signal, "corr-signal");

    expect(warn).toHaveBeenCalledWith("security.login_distributed_attempts", expect.objectContaining({ accountId: "0123456789abcdef", attempts: 20, distinctClients: 7 }));
    expect(renderPrometheus()).toContain("cvg_login_distributed_attempt_signals_total 1");
    expect(store.getState().auditEvents.at(-1)).toMatchObject({
      eventType: "LoginDistributedAttemptsDetected", entityType: "Account", entityId: "0123456789abcdef", correlationId: "corr-signal",
      metadata: { attempts: 20, distinctClients: 7, windowMs: 900000, threshold: 20 }
    });
    expect(JSON.stringify(store.getState().auditEvents.at(-1))).not.toContain("@");
  });

  it("never locks the account: the right password still works after the threshold and the pair backoff is untouched", async () => {
    vi.stubEnv("SESSION_SECRET", ENV.SESSION_SECRET);
    vi.stubEnv("LOGIN_ACCOUNT_SIGNAL_THRESHOLD", "3");
    const store = new MemoryStore(createDemoState("Initial-secret-1234"));
    const pairBefore = await registerLoginFailure({ email: "vet@cvg.local", clientKey: "attacker-0" });
    expect(pairBefore).toBe(1);
    for (let i = 0; i < 5; i += 1) await observeLoginFailure(store, { email: "vet@cvg.local", clientKey: `attacker-${i}` }, `corr-${i}`);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "LoginDistributedAttemptsDetected")).toHaveLength(1);
    // The victim, from their own client, is not delayed and logs in.
    await assertLoginAttempt({ email: "vet@cvg.local", clientKey: "victim" }, { limit: 10, windowMs: 60000 });
    await expect(loginUser(store, "vet@cvg.local", "Initial-secret-1234")).resolves.toMatchObject({ user: { id: "user-vet" } });
    vi.unstubAllEnvs();
  });

  it("observeLoginFailure swallows monitoring failures so a wrong password keeps its response", async () => {
    const warn = vi.fn();
    vi.spyOn(structuredLogger, "createStructuredLogger").mockReturnValue({ warn } as unknown as ReturnType<typeof structuredLogger.createStructuredLogger>);
    vi.spyOn(rateLimit, "consumeRateLimitCounter").mockRejectedValue(new Error("db down"));
    const store = new MemoryStore(createDemoState("Initial-secret-1234"));
    await expect(observeLoginFailure(store, { email, clientKey: "x" }, "corr")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("security.login_signal_unavailable", { component: "security" });
  });
});
