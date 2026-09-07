import { describe, expect, it } from "vitest";
import { createDemoState, passwordFingerprint } from "./fixtures";
import { MemoryStore } from "./memory-store";

describe("MemoryStore fresh reads", () => {
  it("returns an immutable clone from the asynchronous read boundary", async () => {
    const store = new MemoryStore(createDemoState("memory-read-password"));

    const firstRead = await store.readState();
    firstRead.users[0].displayName = "mutated outside the store";
    firstRead.sessions.push({
      id: "external-session",
      userId: firstRead.users[0].id,
      tokenHash: "external-token-hash",
      csrfTokenHash: "external-csrf-hash",
      createdAt: "2026-08-22T00:00:00.000Z",
      expiresAt: "2026-08-22T01:00:00.000Z",
      version: 1
    });

    const secondRead = await store.readState();

    expect(secondRead.users[0].displayName).not.toBe("mutated outside the store");
    expect(secondRead.sessions).toHaveLength(0);
  });

  it("waits for an already queued transaction and observes its committed state", async () => {
    const initialState = createDemoState("memory-queue-password");
    const store = new MemoryStore(initialState);
    let releaseTransaction!: () => void;
    const transactionBarrier = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    let readResolved = false;

    const transaction = store.transaction(async (state) => {
      await transactionBarrier;
      return {
        state: { ...state, protocolSequence: state.protocolSequence + 1 },
        result: undefined
      };
    });
    const read = store.readState().then((state) => {
      readResolved = true;
      return state;
    });

    await Promise.resolve();
    expect(readResolved).toBe(false);

    releaseTransaction();
    await transaction;

    expect((await read).protocolSequence).toBe(initialState.protocolSequence + 1);
  });

  it("resets to a cloned state and exposes deterministic fixture fingerprints", async () => {
    const store = new MemoryStore(createDemoState("memory-reset-password"));
    const replacement = createDemoState("memory-replacement-password");
    replacement.protocolSequence = 42;

    await store.reset(replacement);
    replacement.protocolSequence = 99;

    expect((await store.readState()).protocolSequence).toBe(42);
    expect(passwordFingerprint("memory-reset-password")).toHaveLength(64);
    expect(passwordFingerprint("memory-reset-password")).toBe(passwordFingerprint("memory-reset-password"));
  });
});
