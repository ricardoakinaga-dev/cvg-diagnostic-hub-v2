/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Department } from "@cvg/contracts";
import { ApiClientError, apiFetch } from "./api-client";
import { departmentOptions, useDepartments } from "./use-departments";

vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const sector: Department = { id: "d-onc", code: "ONCOLOGY", name: "Oncologia veterinária", type: "DIAGNOSTIC", memberUserIds: [], active: true, version: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("useDepartments", () => {
  it("uses persisted names and retains unregistered historical codes without making them active choices", () => {
    expect(departmentOptions([sector, { ...sector, id: "old", code: "OLD", name: "Setor anterior", active: false }], ["ARCHIVED", "ONCOLOGY"])).toEqual([
      { code: "ARCHIVED", name: "ARCHIVED", active: false },
      { code: "ONCOLOGY", name: "Oncologia veterinária", active: true, type: "DIAGNOSTIC" },
      { code: "OLD", name: "Setor anterior", active: false, type: "DIAGNOSTIC" }
    ]);
  });
  it("does not fetch before identity exists and refreshes persisted departments after a command", async () => {
    let departments = [sector];
    vi.mocked(apiFetch).mockImplementation(async () => departments as never);
    const hook = renderHook(({ userId }) => useDepartments(userId, { includeInactive: true }), { initialProps: { userId: undefined as string | undefined } });
    await act(async () => {});
    expect(apiFetch).not.toHaveBeenCalled();
    hook.rerender({ userId: "user-1" });
    await waitFor(() => expect(hook.result.current.departments).toEqual([sector]));
    expect(apiFetch).toHaveBeenCalledWith("/departments?includeInactive=true");
    departments = [{ ...sector, name: "Oncologia atualizada", version: 2 }];
    act(() => window.dispatchEvent(new Event("cvg:departments-updated")));
    await waitFor(() => expect(hook.result.current.departments[0]?.version).toBe(2));
  });
  it("hides the previous identity immediately and ignores its late response", async () => {
    let resolveOld: (departments: Department[]) => void = () => undefined;
    const pending = new Promise<Department[]>((resolve) => { resolveOld = resolve; });
    vi.mocked(apiFetch).mockReturnValueOnce(pending as never).mockResolvedValueOnce([]);
    const hook = renderHook(({ id }) => useDepartments(id), { initialProps: { id: "old-user" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    hook.rerender({ id: "new-user" });
    expect(hook.result.current.departments).toEqual([]);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await act(async () => { resolveOld([sector]); await pending; });
    expect(hook.result.current.departments).toEqual([]);
  });
  it("clears directory and catalog on scope revocation instead of retaining selectable old data", async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => path === "/departments" ? [sector] as never : [{ id: "s-onc", departmentCode: sector.code }] as never);
    const hook = renderHook(() => useDepartments("user-1", { catalog: true }));
    await waitFor(() => expect(hook.result.current.departments).toHaveLength(1));
    vi.mocked(apiFetch).mockRejectedValue(new ApiClientError(403, { error: { code: "SCOPE_DENIED" } }));
    await act(async () => { await hook.result.current.reload(); });
    expect(hook.result.current.departments).toEqual([]);
    expect(hook.result.current.services).toEqual([]);
    expect(hook.result.current.error).toBe("Você não tem acesso a este recurso.");
  });
  it("retains only the independently authorized service sector when department metadata is refused", async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === "/departments") throw new ApiClientError(403, { error: { code: "SCOPE_DENIED" } });
      return [{ id: "s-onc", departmentCode: "ONCOLOGY" }] as never;
    });
    const hook = renderHook(() => useDepartments("clinician", { catalog: true }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.departments).toEqual([]);
    expect(hook.result.current.services).toEqual([{ id: "s-onc", departmentCode: "ONCOLOGY" }]);
    expect(hook.result.current.error).toBe("Você não tem acesso a este recurso.");
  });
});
