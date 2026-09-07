/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  apiFetchWithMeta,
  createClientUniqueId,
  getSafeErrorMessage,
} from "./index";

describe("shared browser service client", () => {
  it("normalizes known and unknown failures without exposing server details", () => {
    const known = new ApiClientError(403, {
      error: { code: "SCOPE_DENIED", correlationId: "corr-1", message: "internal detail" },
    });
    expect(known).toMatchObject({
      name: "ApiClientError",
      code: "SCOPE_DENIED",
      correlationId: "corr-1",
      status: 403,
      message: "Você não tem acesso a este recurso.",
    });

    const unknown = new ApiClientError(500, {
      error: { code: "UNLISTED", message: "postgres://user:secret@host/db" },
    });
    expect(unknown.message).toBe("Não foi possível concluir a operação. Informe o código de correlação ao suporte.");
    expect(getSafeErrorMessage(known, "fallback")).toBe(known.message);
    expect(getSafeErrorMessage(new Error("private"), "fallback")).toBe("fallback");
  });

  it("creates an idempotency id through the available crypto fallback", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => { bytes.fill(9); return bytes; } });
    expect(createClientUniqueId()).toBe("09090909090909090909090909090909");
    vi.unstubAllGlobals();
  });

  it("adds JSON, CSRF and idempotency headers only where the request needs them", async () => {
    document.cookie = "cvg_csrf=services-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ data: { ok: true }, meta: { correlationId: "corr", requestId: "req" } }),
      { status: 200 },
    ));

    await expect(apiFetchWithMeta<{ ok: boolean }>("/diagnostics", { method: "POST", body: "{}" })).resolves.toEqual({
      data: { ok: true },
      meta: { correlationId: "corr", requestId: "req" },
    });
    const postHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(postHeaders.get("accept")).toBe("application/json");
    expect(postHeaders.get("content-type")).toBe("application/json");
    expect(postHeaders.get("x-csrf-token")).toBe("services-test");
    expect(postHeaders.get("idempotency-key")).toBeTruthy();

    await expect(apiFetchWithMeta<{ ok: boolean }>("/diagnostics", { method: "GET" })).resolves.toEqual({
      data: { ok: true },
      meta: { correlationId: "corr", requestId: "req" },
    });
    const getHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
    expect(getHeaders.get("accept")).toBe("application/json");
    expect(getHeaders.get("content-type")).toBeNull();
    expect(getHeaders.get("idempotency-key")).toBeNull();

    fetchMock.mockRestore();
  });

  it("fails closed for malformed envelopes and malformed failure bodies", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: true, meta: { requestId: "req" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not-an-object" }), { status: 422 }));

    await expect(apiFetchWithMeta("/malformed-success")).rejects.toMatchObject({ status: 200, code: undefined });
    await expect(apiFetchWithMeta("/malformed-error")).rejects.toMatchObject({ status: 422, code: undefined });
    fetchMock.mockRestore();
  });
});
