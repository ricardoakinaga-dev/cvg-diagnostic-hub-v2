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
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({ event: "secrets.loaded", loaded: ["METRICS_SCRAPE_TOKEN"] });
      expect(line).not.toContain("scrape-token-from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing on the edge runtime and stays silent without secrets", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    expect(log).not.toHaveBeenCalled();
  });
});
