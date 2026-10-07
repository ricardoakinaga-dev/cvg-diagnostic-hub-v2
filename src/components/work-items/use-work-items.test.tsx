/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@cvg/contracts";
import { apiFetch, apiFetchWithMeta } from "@/components/api-client";
import { useWorkItems, workedDepartments } from "./use-work-items";

vi.mock("@/components/api-client", async (importOriginal) => ({ ...await importOriginal<typeof import("@/components/api-client")>(), apiFetch: vi.fn(), apiFetchWithMeta: vi.fn() }));
const user: SessionUser = { id: "vet", email: "vet@cvg.local", displayName: "Vet", role: "VETERINARIAN", departmentCode: "INPATIENT", timezone: "UTC" };
const request = { id: "req", requestCode: "EX-261006-0001", priority: "ROUTINE", createdAt: "2026-10-06T12:00:00Z", patient: { id: "patient", displayName: "Thor", species: "Canino", externalId: "THOR" }, items: [{ id: "item", status: "REQUESTED", priority: "ROUTINE", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 1, dueAt: "2026-10-06T14:00:00Z", service: { id: "s", code: "HEM", name: "Hemograma" } }] };

function session(current = user) {
  vi.mocked(apiFetch).mockResolvedValue({ user: current } as never);
  vi.mocked(apiFetchWithMeta).mockResolvedValue({ data: [request], meta: {} } as never);
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("work item loading", () => {
  it("deduplicates a manager's department scope and isolates executor queues", () => {
    expect(workedDepartments({ ...user, role: "MANAGER", departmentCode: "LABORATORY", managedDepartmentCodes: ["LABORATORY", "RADIOLOGY"] })).toEqual(["LABORATORY", "RADIOLOGY"]);
    for (const role of ["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"] as const) expect(workedDepartments({ ...user, role, departmentCode: "LABORATORY" })).toEqual(["LABORATORY"]);
    expect(workedDepartments(user)).toEqual([]);
  });

  it("follows encoded pagination cursors and stops at a missing cursor", async () => {
    session();
    vi.mocked(apiFetchWithMeta).mockResolvedValueOnce({ data: [request], meta: { nextCursor: "cursor+/=" } } as never).mockResolvedValueOnce({ data: [], meta: { nextCursor: "" } } as never);
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetchWithMeta).toHaveBeenNthCalledWith(2, "/diagnostic-requests?limit=100&cursor=cursor%2B%2F%3D");
    expect(result.current.items).toHaveLength(1);
    expect(result.current.truncated).toBe(false);
  });

  it("bounds pagination and reports truncation instead of pretending to be complete", async () => {
    session();
    vi.mocked(apiFetchWithMeta).mockResolvedValue({ data: [request], meta: { nextCursor: "more" } } as never);
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetchWithMeta).toHaveBeenCalledTimes(10);
    expect(result.current.truncated).toBe(true);
  });

  it("preserves requests while explaining an unavailable executor queue", async () => {
    session({ ...user, role: "LAB_TECH", departmentCode: "LABORATORY" });
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => {
      if (path.startsWith("/queues")) throw new Error("queue offline");
      return { data: [request], meta: {} } as never;
    });
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.partial).toContain("Parte das filas");
    expect(result.current.error).toBe("");
  });

  it("reports queue truncation independently of request pagination", async () => {
    session({ ...user, role: "LAB_TECH", departmentCode: "LABORATORY" });
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => ({ data: path.startsWith("/queues") ? [] : [request], meta: path.startsWith("/queues") ? { nextCursor: "more" } : {} }) as never);
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.truncated).toBe(true);
  });

  it("keeps the latest reload when an older session response finishes later", async () => {
    session();
    let finishOld!: (value: unknown) => void;
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }) as never);
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.reload(); });
    await act(async () => { finishOld({ user: { ...user, id: "old-user" } }); });
    expect(result.current.user?.id).toBe("vet");
    expect(result.current.loading).toBe(false);
  });

  it("does not replace confirmed items when refresh fails and patches only the target", async () => {
    session();
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.patch("missing", { status: "CANCELLED" }); result.current.patch("item", { status: "RECEIVED" }); });
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("session offline"));
    await act(async () => { await result.current.reload(); });
    expect(result.current.items[0].status).toBe("RECEIVED");
    expect(result.current.error).toBeTruthy();
    expect(result.current.refreshing).toBe(false);
  });

  it("refreshes after resync and removes listeners on unmount", async () => {
    session();
    const { result, unmount } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(apiFetch).mockClear();
    act(() => { window.dispatchEvent(new Event("cvg:realtime-resync")); });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    unmount();
    vi.mocked(apiFetch).mockClear();
    window.dispatchEvent(new Event("cvg:realtime-updated"));
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
