import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation";

describe("Next instrumentation (PROD-302)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads NAME_FILE secrets into the environment on the node runtime and logs only the names", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cvg-instrumentation-"));
    try {
      writeFileSync(path.join(dir, "token"), "scrape-token-from-file\n");
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      vi.stubEnv("METRICS_SCRAPE_TOKEN", "");
      vi.stubEnv("METRICS_SCRAPE_TOKEN_FILE", path.join(dir, "token"));
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await register();

      expect(process.env.METRICS_SCRAPE_TOKEN).toBe("scrape-token-from-file");
      expect(log).toHaveBeenCalledTimes(2);
      const line = String(log.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({ event: "secrets.loaded", loaded: ["METRICS_SCRAPE_TOKEN"] });
      expect(line).not.toContain("scrape-token-from-file");
      expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual({ event: "app.start", revision: "unknown" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing on the edge runtime and, without secrets, logs only the commit it serves", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(log).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("CVG_BUILD_REVISION", "0123456789abcdef0123456789abcdef01234567");
    await register();
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: "app.start", revision: "0123456789abcdef0123456789abcdef01234567" }]);
  });
});
