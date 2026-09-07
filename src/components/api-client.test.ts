/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { apiFetch, formatRelativeTime } from "./api-client";

describe("browser API client", () => {
  it("adds cookie CSRF/idempotency headers and unwraps a successful envelope", async () => {
    document.cookie = "cvg_csrf=csrf-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { ok: true }, meta: { correlationId: "c", requestId: "r" } }), { status: 200 }));
    await expect(apiFetch<{ ok: boolean }>("/diagnostic-requests", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("csrf-test");
    expect(headers.get("idempotency-key")).toBeTruthy();
    fetchMock.mockRestore();
  });

  it("generates an idempotency key when randomUUID is unavailable on a LAN origin", async () => {
    document.cookie = "cvg_csrf=csrf-lan";
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => { bytes.fill(7); return bytes; } });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { ok: true }, meta: { correlationId: "c", requestId: "r" } }), { status: 200 }));

    await expect(apiFetch<{ ok: boolean }>("/session/login", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });
    expect((fetchMock.mock.calls[0][1]?.headers as Headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{32,}$/);

    fetchMock.mockRestore();
    vi.unstubAllGlobals();
  });

  it("turns safe API failures into useful client errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { code: "SCOPE_DENIED", message: "Sem acesso", correlationId: "c" } }), { status: 404 }));
    await expect(apiFetch("/patients/patient-secret")).rejects.toMatchObject({ code: "SCOPE_DENIED", correlationId: "c" });
    fetchMock.mockRestore();
  });

  it("does not expose an unsafe server error message to the browser", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "postgres://user:password@host/db" } }), { status: 500 }));
    await expect(apiFetch("/dashboard")).rejects.toMatchObject({ message: "Não foi possível concluir a operação. Informe o código de correlação ao suporte." });
    fetchMock.mockRestore();
  });

  it("redacts parser failures for non-JSON responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>database password</html>", { status: 502 }));
    await expect(apiFetch("/dashboard")).rejects.toMatchObject({
      message: "Não foi possível concluir a operação. Informe o código de correlação ao suporte.",
      status: 502,
    });
    fetchMock.mockRestore();
  });

  it("rejects a malformed success envelope with a safe client error", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ message: "private server detail" }), { status: 200 }));
    await expect(apiFetch("/dashboard")).rejects.toMatchObject({
      message: "Não foi possível concluir a operação. Informe o código de correlação ao suporte.",
      status: 200,
    });
    fetchMock.mockRestore();
  });

  it("formats recent and old timestamps without exposing internal details", () => {
    expect(formatRelativeTime(new Date(Date.now() - 10_000).toISOString())).toBe("agora");
    expect(formatRelativeTime(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())).toBe("há 2 h");
  });

  it("keeps future deadlines directional instead of calling them current", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    try {
      expect(formatRelativeTime("2026-09-06T12:00:30.000Z")).toBe("em instantes");
      expect(formatRelativeTime("2026-09-06T13:30:00.000Z")).toBe("em 2 h");
      expect(formatRelativeTime("2026-09-07T12:00:00.000Z")).toBe("em 1 dia");
    } finally {
      vi.useRealTimers();
    }
  });
});
