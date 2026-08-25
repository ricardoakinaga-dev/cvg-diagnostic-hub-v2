import { describe, expect, it } from "vitest";
import { buildQueueFilterQuery } from "./index";

describe("queue filter shared state", () => {
  it("serializes only explicit UI filters", () => {
    expect(buildQueueFilterQuery({ overdue: true, status: "RESULT_AVAILABLE" })).toBe("overdue=true&status=RESULT_AVAILABLE");
    expect(buildQueueFilterQuery({ overdue: false, status: "ALL" })).toBe("");
  });
});
