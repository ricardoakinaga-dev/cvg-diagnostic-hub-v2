import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, proxy } from "./proxy";

function nonceFrom(policy: string | null): string | undefined {
  return policy?.match(/'nonce-([^']+)'/)?.[1];
}

describe("request proxy CSP", () => {
  it("emits a per-request nonce on the response and forwards the same policy to the renderer", () => {
    const first = proxy(new NextRequest("https://hub.example.org/login"));
    const second = proxy(new NextRequest("https://hub.example.org/login"));

    const policy = first.headers.get("content-security-policy");
    const nonce = nonceFrom(policy);
    expect(nonce).toBeTruthy();
    expect(nonceFrom(second.headers.get("content-security-policy"))).not.toBe(nonce);
    // NextResponse.next encodes forwarded request headers as x-middleware-request-*.
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
  });

  it("allows eval only in development", () => {
    expect(buildContentSecurityPolicy("n", false)).not.toContain("unsafe-eval");
    expect(buildContentSecurityPolicy("n", true)).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy("n", false)).toMatch(/frame-ancestors 'none'.*|object-src 'none'/);
  });
});
