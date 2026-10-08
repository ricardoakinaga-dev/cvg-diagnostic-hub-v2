import { describe, expect, it } from "vitest";
import { ApiError } from "../../../../server/http/envelope";
import { isDependencyUnavailable, normalizeRouteError } from "./route-support";

describe("dependency outage classification", () => {
  it.each([
    ["connection refused", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })],
    ["administrator shutdown", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })],
    ["connection exception class 08", Object.assign(new Error("connection failure"), { code: "08006" })],
    ["statement timeout", Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })],
    ["client connect timeout", new Error("timeout exceeded when trying to connect")],
    ["client query timeout", new Error("Query read timeout")],
    ["terminated socket", new Error("Connection terminated unexpectedly")],
    ["wrapped store open failure", new Error("Não foi possível abrir o estado PostgreSQL. connect ECONNREFUSED 127.0.0.1:5432")],
    ["outage behind a cause chain", new Error("readState failed", { cause: Object.assign(new Error("x"), { code: "57P03" }) })]
  ])("maps %s to a retryable 503", (_label, error) => {
    expect(isDependencyUnavailable(error)).toBe(true);
    const normalized = normalizeRouteError(error);
    expect(normalized).toBeInstanceOf(ApiError);
    expect(normalized).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503, details: { retryable: true } });
  });

  it.each([
    ["programming error", new TypeError("cannot read properties of undefined")],
    ["unique violation", Object.assign(new Error("duplicate key"), { code: "23505" })],
    ["not an error", "ECONNREFUSED"],
    ["undefined", undefined]
  ])("keeps %s as it was", (_label, error) => {
    expect(isDependencyUnavailable(error)).toBe(false);
    expect(normalizeRouteError(error)).toBe(error);
  });

  it("never rewrites an explicit API error", () => {
    const explicit = new ApiError("RATE_LIMIT_UNAVAILABLE", "x", 503, { retryable: true });
    expect(normalizeRouteError(Object.assign(explicit, { code: "RATE_LIMIT_UNAVAILABLE" }))).toBe(explicit);
  });
});
