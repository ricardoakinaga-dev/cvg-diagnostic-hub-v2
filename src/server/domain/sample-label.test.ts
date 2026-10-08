import { describe, expect, it } from "vitest";
import { labelDimensionsFromEnv } from "./sample-label";

describe("label dimensions", () => {
  it("defaults to 50 x 30 mm", () => {
    expect(labelDimensionsFromEnv({})).toEqual({ widthMm: 50, heightMm: 30 });
    expect(labelDimensionsFromEnv({ LABEL_WIDTH_MM: " ", LABEL_HEIGHT_MM: "" })).toEqual({ widthMm: 50, heightMm: 30 });
  });

  it("reads configured values inside 20-150 mm", () => {
    expect(labelDimensionsFromEnv({ LABEL_WIDTH_MM: "100", LABEL_HEIGHT_MM: "25.5" })).toEqual({ widthMm: 100, heightMm: 25.5 });
    expect(labelDimensionsFromEnv({ LABEL_WIDTH_MM: "20", LABEL_HEIGHT_MM: "150" })).toEqual({ widthMm: 20, heightMm: 150 });
  });

  it.each(["19", "151", "abc", "NaN", "Infinity"])("rejects %s", (value) => {
    expect(() => labelDimensionsFromEnv({ LABEL_WIDTH_MM: value })).toThrow(/LABEL_WIDTH_MM/);
    expect(() => labelDimensionsFromEnv({ LABEL_HEIGHT_MM: value })).toThrow(/LABEL_HEIGHT_MM/);
  });
});
