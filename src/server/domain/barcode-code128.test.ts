import { describe, expect, it } from "vitest";
import { CODE128_QUIET_ZONE_MODULES, code128Checksum, code128Geometry, encodeCode128B } from "./barcode-code128";

describe("Code 128 subset B", () => {
  it("computes the modulo-103 checksum by hand for PJJ123C", () => {
    // 104 + 1*48 + 2*42 + 3*42 + 4*17 + 5*18 + 6*19 + 7*35 = 879; 879 mod 103 = 55.
    const symbol = encodeCode128B("PJJ123C");
    expect(symbol.values).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
    expect(symbol.checksum).toBe(55);
    expect(code128Checksum([48, 42, 42, 17, 18, 19, 35])).toBe(55);
  });

  it("uses 11 modules per symbol plus the 13-module stop", () => {
    const symbol = encodeCode128B("A261008-00018");
    expect(symbol.widths).toHaveLength((symbol.values.length - 1) * 6 + 7);
    expect(symbol.modules).toBe((symbol.values.length - 1) * 11 + 13);
    expect(symbol.widths.slice(0, 6)).toEqual([2, 1, 1, 2, 1, 4]);
    expect(symbol.widths.slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]);
  });

  it("returns one bar per dark run, offset by the quiet zone, inside the total module count", () => {
    const symbol = encodeCode128B("AB");
    const geometry = code128Geometry("AB");
    expect(geometry.bars).toHaveLength((symbol.widths.length + 1) / 2);
    expect(geometry.modules).toBe(symbol.modules + CODE128_QUIET_ZONE_MODULES * 2);
    expect(geometry.bars[0]).toEqual({ x: CODE128_QUIET_ZONE_MODULES, width: 2 });
    const last = geometry.bars[geometry.bars.length - 1];
    expect(last.x + last.width).toBe(geometry.modules - CODE128_QUIET_ZONE_MODULES);
    expect(geometry.bars.every((bar, index) => index === 0 || bar.x > geometry.bars[index - 1].x + geometry.bars[index - 1].width)).toBe(true);
  });

  it("rejects empty text and characters outside subset B", () => {
    expect(() => encodeCode128B("")).toThrow(RangeError);
    expect(() => encodeCode128B("é")).toThrow(/subconjunto B/);
    expect(() => encodeCode128B("a\nb")).toThrow(RangeError);
  });

  it("has a valid, unique pattern for every symbol value", () => {
    const widths = new Set<string>();
    for (let value = 0; value < 95; value += 1) {
      const symbol = encodeCode128B(String.fromCharCode(value + 32));
      const pattern = symbol.widths.slice(6, 12);
      expect(pattern.reduce((sum, width) => sum + width, 0)).toBe(11);
      expect((pattern[0] + pattern[2] + pattern[4]) % 2).toBe(0);
      widths.add(pattern.join(""));
    }
    expect(widths.size).toBe(95);
  });
});
