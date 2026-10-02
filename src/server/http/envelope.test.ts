import { describe, expect, it } from "vitest";
import { createApiError, createSuccessResponse, toApiErrorResponse } from "./envelope";

describe("API envelope", () => {
  it("returns a stable success envelope with correlation metadata", () => {
    const response = createSuccessResponse({ ok: true }, "corr_test", "req_test");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: { ok: true },
      meta: { correlationId: "corr_test", requestId: "req_test" }
    });
  });

  it("maps domain errors without leaking implementation details", () => {
    const response = toApiErrorResponse(
      createApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404),
      "corr_safe",
      "req_safe"
    );

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: "SCOPE_DENIED",
      message: "Você não tem acesso a este recurso.",
      correlationId: "corr_safe"
    });
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });

  it("maps structured errors from lower operation layers without importing HTTP", () => {
    const error = Object.assign(new Error("Mensagem não disponível."), { name: "ApiError", code: "OUTBOX_NOT_DEAD_LETTERED", status: 409 });
    const response = toApiErrorResponse(error, "corr_outbox", "req_outbox");

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: "OUTBOX_NOT_DEAD_LETTERED", message: "Mensagem não disponível.", correlationId: "corr_outbox" });
  });
});
