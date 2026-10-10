import { describe, expect, it } from "vitest";
import { buildRevision, startupEvent } from "./build-info";

describe("build provenance", () => {
  it("reports the stamped commit and refuses anything that is not one", () => {
    expect(buildRevision({ CVG_BUILD_REVISION: "0123456789abcdef0123456789abcdef01234567" })).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(buildRevision({ CVG_BUILD_REVISION: " 0123456789ABCDEF0123456789ABCDEF01234567\n" })).toBe("0123456789abcdef0123456789abcdef01234567");
    for (const value of [undefined, "", "unknown", "latest", "20261003", "0123abc", "0123456789abcdef0123456789abcdef012345678", "0123456789abcdef0123456789abcdef0123456;"]) {
      expect(buildRevision({ CVG_BUILD_REVISION: value })).toBe("unknown");
    }
  });

  it("writes one startup event per process with the revision", () => {
    const commit = "abcdef0123456789abcdef0123456789abcdef01";
    expect(JSON.parse(startupEvent("worker", { CVG_BUILD_REVISION: commit }))).toEqual({ event: "worker.start", revision: commit });
    expect(JSON.parse(startupEvent("app", {}))).toEqual({ event: "app.start", revision: "unknown" });
  });
});
