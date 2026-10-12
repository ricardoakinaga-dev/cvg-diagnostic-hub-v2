/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@cvg/contracts";
import { ApiClientError, apiFetch, apiFetchWithMeta } from "@/components/api-client";
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
  it("does not require diagnostic reads or catalog access for a task-only superadmin group", async () => {
    session({ ...user, role: "SUPERADMIN", permissions: ["hospital_task.view"] });
    vi.mocked(apiFetchWithMeta).mockRejectedValue(new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }));
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user?.role).toBe("SUPERADMIN"); expect(result.current.error).toBe(""); expect(result.current.items).toEqual([]);
    expect(apiFetch).toHaveBeenCalledTimes(1); expect(apiFetchWithMeta).not.toHaveBeenCalled();
  });
  it("reads authorized requests without consulting an ungranted department queue", async () => {
    session({ ...user, role: "MANAGER", managedDepartmentCodes: ["LABORATORY"], permissions: ["request.list", "item.view"] });
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => { if (path.startsWith("/queues/")) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return { data: [request], meta: {} } as never; });
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false)); expect(result.current.items).toHaveLength(1); expect(result.current.error).toBe(""); expect(apiFetchWithMeta).toHaveBeenCalledExactlyOnceWith("/diagnostic-requests?limit=50");
  });
  it("reads an authorized queue without querying requests that the group cannot list", async () => {
    session({ ...user, role: "LAB_TECH", departmentCode: "LABORATORY", permissions: ["queue.view", "item.view"] });
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => { if (path.startsWith("/diagnostic-requests")) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return { data: [{ ...request.items[0], requestId: request.id, requestCode: request.requestCode, patient: request.patient, createdAt: request.createdAt, overdue: false }], meta: {} } as never; });
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false)); expect(result.current.items).toHaveLength(1); expect(result.current.items[0].requestId).toBe(request.id); expect(result.current.error).toBe(""); expect(apiFetchWithMeta).toHaveBeenCalledExactlyOnceWith("/queues/LABORATORY/items?limit=50");
  });
  it("loads later pages on demand, retries without losing the confirmed page and deduplicates", async () => {
    session();
    const older = { ...request, id: "older", items: [{ ...request.items[0], id: "older-item" }] };
    vi.mocked(apiFetchWithMeta).mockResolvedValueOnce({ data: [request], meta: { nextCursor: "older" } } as never).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: [request, older], meta: {} } as never);
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.paginationError).toBeTruthy();
    expect(result.current.truncated).toBe(true);
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.items).toHaveLength(2);
    expect(result.current.truncated).toBe(false);
    expect(apiFetchWithMeta).toHaveBeenLastCalledWith("/diagnostic-requests?limit=50&cursor=older");
  });
  it("clears current data and identity when access is refused after revocation", async () => {
    session();
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    vi.mocked(apiFetchWithMeta).mockRejectedValueOnce(new ApiClientError(403, { error: { code: "SCOPE_DENIED" } }));
    await act(async () => { await result.current.reload(); });
    expect(result.current.items).toEqual([]);
    expect(result.current.user).toBeNull();
    expect(result.current.truncated).toBe(false);
  });
  it("clears confirmed pages when continuation access is revoked", async () => {
    session();
    vi.mocked(apiFetchWithMeta).mockResolvedValueOnce({ data: [request], meta: { nextCursor: "older" } } as never).mockRejectedValueOnce(new ApiClientError(403, { error: { code: "SCOPE_DENIED" } }));
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.items).toEqual([]);
    expect(result.current.user).toBeNull();
    expect(result.current.truncated).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
  it("removes the previous person's clinical data before a different identity's page finishes", async () => {
    session();
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    vi.mocked(apiFetch).mockResolvedValueOnce({ user: { ...user, id: "other-user" } } as never);
    let finishPage!: (value: unknown) => void;
    vi.mocked(apiFetchWithMeta).mockImplementationOnce(() => new Promise((resolve) => { finishPage = resolve; }) as never);
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.reload(); });
    await waitFor(() => expect(result.current.user?.id).toBe("other-user"));
    expect(result.current.items).toEqual([]);
    await act(async () => { finishPage({ data: [], meta: {} }); await refresh; });
    expect(result.current.items).toEqual([]);
  });
  it("fails closed on a revoked executor queue even when the request endpoint succeeds", async () => {
    session({ ...user, role: "LAB_TECH", departmentCode: "LABORATORY" });
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => {
      if (path.startsWith("/queues")) throw new ApiClientError(403, { error: { code: "SCOPE_DENIED" } });
      return { data: [request], meta: {} } as never;
    });
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([]);
    expect(result.current.user).toBeNull();
    expect(result.current.error).toBeTruthy();
  });
  it("loads registered catalog queues for SUPERADMIN including a new department without treating an empty catalog as global", async () => {
    session({ ...user, role: "SUPERADMIN", departmentCode: "IT" });
    vi.mocked(apiFetch).mockImplementation(async (path) => path === "/session/me" ? { user: { ...user, role: "SUPERADMIN", departmentCode: "IT" } } : [{ departmentCode: "PATHOLOGY" }, { departmentCode: "PATHOLOGY" }, { departmentCode: "LABORATORY" }] as never);
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => ({ data: path.startsWith("/queues") ? [] : [request], meta: {} }) as never);
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(1);
    for (const code of ["LABORATORY", "PATHOLOGY"]) expect(apiFetchWithMeta).toHaveBeenCalledWith(`/queues/${code}/items?limit=50`);
    expect(apiFetchWithMeta).not.toHaveBeenCalledWith("/queues/IT/items?limit=50");
    expect(workedDepartments({ ...user, role: "SUPERADMIN" }, [])).toEqual([]);
  });
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
    expect(result.current.truncated).toBe(true);
    await act(async () => { await result.current.loadMore(); });
    expect(apiFetchWithMeta).toHaveBeenNthCalledWith(2, "/diagnostic-requests?limit=50&cursor=cursor%2B%2F%3D");
    expect(result.current.items).toHaveLength(1);
    expect(result.current.truncated).toBe(false);
  });

  it("starts with one bounded page and exposes explicit continuation", async () => {
    session();
    vi.mocked(apiFetchWithMeta).mockResolvedValue({ data: [request], meta: { nextCursor: "more" } } as never);
    const { result } = renderHook(useWorkItems);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetchWithMeta).toHaveBeenCalledTimes(1);
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
