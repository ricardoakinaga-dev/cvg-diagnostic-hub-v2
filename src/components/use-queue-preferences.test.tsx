/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queuePreferenceKey, readQueuePreferences, useQueuePreferences } from "./use-queue-preferences";

const fallback = { search: "", layout: "list" };
const normalize = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? { search: typeof (value as typeof fallback).search === "string" ? (value as typeof fallback).search : "", layout: (value as typeof fallback).layout === "board" ? "board" : "list" } : fallback;
afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });

describe("queue preferences ownership", () => {
  it("persists by person and route and never renders another identity's search on switch", async () => {
    const { result, rerender, unmount } = renderHook(({ user, route }) => useQueuePreferences(user, route, fallback, normalize), { initialProps: { user: "a", route: "/queues?dept=LAB" } });
    await waitFor(() => expect(result.current[0]).toEqual(fallback));
    act(() => result.current[1]({ search: "Thor", layout: "board" }));
    expect(result.current[0].search).toBe("Thor");
    rerender({ user: "b", route: "/queues?dept=LAB" });
    expect(result.current[0]).toEqual(fallback);
    act(() => result.current[1]({ search: "Mel", layout: "list" }));
    rerender({ user: "a", route: "/queues?dept=RX" });
    expect(result.current[0]).toEqual(fallback);
    rerender({ user: "a", route: "/queues?dept=LAB" });
    await waitFor(() => expect(result.current[0].search).toBe("Thor"));
    unmount();
    expect(readQueuePreferences("b", "/queues?dept=LAB", fallback, normalize).search).toBe("Mel");
  });
  it("discards unowned legacy preferences and rejects a forged ownership envelope", () => {
    window.localStorage.setItem("cvg.work-items.display.v1", JSON.stringify({ search: "Previous person's patient", layout: "board" }));
    expect(readQueuePreferences("a", "/queues", fallback, normalize, ["cvg.work-items.display.v1"])).toEqual(fallback);
    expect(window.localStorage.getItem("cvg.work-items.display.v1")).toBeNull();
    window.localStorage.setItem(queuePreferenceKey("a", "/queues"), JSON.stringify({ version: 2, userId: "b", view: "/queues", value: { search: "Private", layout: "board" } }));
    expect(readQueuePreferences("a", "/queues", fallback, normalize)).toEqual(fallback);
  });
  it("clears in-memory choices on logout and does not persist anonymous edits", async () => {
    const { result, rerender } = renderHook(({ user }: { user?: string }) => useQueuePreferences(user, "/queues", fallback, normalize), { initialProps: { user: "a" as string | undefined } });
    act(() => result.current[1]({ search: "Thor", layout: "board" }));
    rerender({ user: undefined });
    expect(result.current[0]).toEqual(fallback);
    act(() => result.current[1]({ search: "Anonymous", layout: "board" }));
    expect(result.current[0]).toEqual(fallback);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(queuePreferenceKey("a", "/queues"))!).value.search).toBe("Thor"));
  });
  it("tolerates invalid JSON and blocked browser storage", () => {
    window.localStorage.setItem(queuePreferenceKey("a", "/queues"), "broken");
    expect(readQueuePreferences("a", "/queues", fallback, normalize)).toEqual(fallback);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readQueuePreferences("a", "/queues", fallback, normalize)).toEqual(fallback);
  });
});
