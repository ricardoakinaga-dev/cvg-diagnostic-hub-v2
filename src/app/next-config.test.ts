import { describe, expect, it } from "vitest";

type NextConfigForTest = {
  headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>;
  experimental?: { proxyClientMaxBodySize?: string | number };
};

describe("Next.js security and upload configuration", () => {
  it("keeps the required security headers and the attachment body limit", async () => {
    const configPath: string = "../../next.config.mjs";
    const nextConfig = (await import(configPath)).default as NextConfigForTest;
    const routes = await nextConfig.headers();
    const headers = new Map(routes[0]?.headers.map((header) => [header.key, header.value]));

    expect(headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe("25mb");
  });
});
