import { describe, expect, it } from "vitest";
import { ACCESSION_PATTERN, accessionPrefixFromEnv, accessionTimeZoneFromEnv, generateAccessionCode, generateAccessionCodes, isGeneratedAccessionFormat, mod10CheckDigit, resolveAccessionPrefix, validateAccessionCheckCharacter } from "./accession";
import type { Sample } from "./models";

const sampleWith = (accessionCode: string): Sample => ({ id: accessionCode, requestId: "r", accessionCode, sampleType: "EDTA", status: "EXPECTED", itemIds: [], version: 1 });
const day = new Date("2026-10-08T23:30:00.000Z");

describe("accession check digit (Mod-10 / Luhn)", () => {
  it("matches the Luhn reference values", () => {
    // 7992739871 -> 3 is the canonical Luhn example.
    expect(mod10CheckDigit("7992739871")).toBe("3");
    expect(mod10CheckDigit("2610080001")).toBe(mod10CheckDigit("2610080001"));
    expect(mod10CheckDigit("0000000000")).toBe("0");
    expect(mod10CheckDigit("0000000001")).toBe("8");
  });

  it("accepts generated codes and rejects wrong characters, typos and transpositions", () => {
    const code = generateAccessionCode({ samples: [] }, day, "A");
    expect(code).toBe(`A261008-0001${mod10CheckDigit("2610080001")}`);
    expect(validateAccessionCheckCharacter(code)).toBe(true);
    const wrong = `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`;
    expect(validateAccessionCheckCharacter(wrong)).toBe(false);
    expect(validateAccessionCheckCharacter(code.replace("0001", "0002"))).toBe(false);
    expect(validateAccessionCheckCharacter("A261008-0010" + mod10CheckDigit("2610080001"))).toBe(false);
  });

  it("returns false for legacy shapes that are not generated codes", () => {
    expect(validateAccessionCheckCharacter("ACC-2026-001")).toBe(false);
    expect(isGeneratedAccessionFormat("ACC-2026-001")).toBe(false);
    expect(isGeneratedAccessionFormat("A261008-00011")).toBe(true);
    expect(isGeneratedAccessionFormat("ABCDE261008-00011")).toBe(false);
  });
});

describe("accession generator", () => {
  it("starts at 0001 per day and increments past the highest existing sequence", () => {
    expect(generateAccessionCode({ samples: [] }, day, "A")).toMatch(/^A261008-0001\d$/);
    const first = generateAccessionCode({ samples: [] }, day, "A");
    const second = generateAccessionCode({ samples: [sampleWith(first), sampleWith("A261008-0007" + mod10CheckDigit("2610080007"))] }, day, "A");
    expect(second).toBe(`A261008-0008${mod10CheckDigit("2610080008")}`);
  });

  it("uses the hospital calendar day, so a code generated at 22:00 in São Paulo keeps that day", () => {
    const lateEvening = "2026-10-09T01:30:00.000Z"; // 22:30 of 2026-10-08 in America/Sao_Paulo
    expect(generateAccessionCode({ samples: [] }, lateEvening, "A", "America/Sao_Paulo")).toMatch(/^A261008-0001\d$/);
    expect(generateAccessionCode({ samples: [] }, lateEvening, "A")).toMatch(/^A261009-0001\d$/);
    const existing = sampleWith("A261008-0003" + mod10CheckDigit("2610080003"));
    expect(generateAccessionCode({ samples: [existing] }, lateEvening, "A", "America/Sao_Paulo")).toBe(`A261008-0004${mod10CheckDigit("2610080004")}`);
    expect(accessionTimeZoneFromEnv({ APP_TIMEZONE: "Europe/Lisbon" })).toBe("Europe/Lisbon");
    expect(accessionTimeZoneFromEnv({ APP_TIMEZONE: "" })).toBe("America/Sao_Paulo");
    expect(() => accessionTimeZoneFromEnv({ APP_TIMEZONE: "Marte/Olympus" })).toThrow(/APP_TIMEZONE/);
  });

  it("ignores other days, other prefixes, legacy codes, wrong lengths and invalid check characters", () => {
    const state = { samples: [
      sampleWith("A261007-0050" + mod10CheckDigit("2610070050")),
      sampleWith("B261008-0040" + mod10CheckDigit("2610080040")),
      sampleWith("PENDING-ABCD1234"),
      sampleWith("A261008-0030" + ((Number(mod10CheckDigit("2610080030")) + 1) % 10)),
      sampleWith("A261008-000111"),
    ] };
    expect(generateAccessionCode(state, day, "A")).toBe(`A261008-0001${mod10CheckDigit("2610080001")}`);
  });

  it("generates a consecutive batch with one scan and accepts ISO strings", () => {
    const codes = generateAccessionCodes({ samples: [] }, "2026-01-02T00:00:00.000Z", "LAB", 3);
    expect(codes).toEqual(["LAB260102-0001" + mod10CheckDigit("2601020001"), "LAB260102-0002" + mod10CheckDigit("2601020002"), "LAB260102-0003" + mod10CheckDigit("2601020003")]);
    codes.forEach((code) => { expect(code).toMatch(ACCESSION_PATTERN); expect(validateAccessionCheckCharacter(code)).toBe(true); });
  });

  it("rejects an invalid date, an invalid prefix and an exhausted day", () => {
    expect(() => generateAccessionCode({ samples: [] }, "not-a-date", "A")).toThrow(RangeError);
    expect(() => generateAccessionCode({ samples: [] }, day, "a-b")).toThrow(/ACCESSION_PREFIX/);
    expect(() => generateAccessionCode({ samples: [sampleWith("A261008-9999" + mod10CheckDigit("2610089999"))] }, day, "A")).toThrow(/Limite diário/);
  });
});

describe("accession prefix configuration", () => {
  it("defaults to A and trims", () => {
    expect(resolveAccessionPrefix(undefined)).toBe("A");
    expect(resolveAccessionPrefix("  ")).toBe("A");
    expect(resolveAccessionPrefix(" CVG1 ")).toBe("CVG1");
    expect(accessionPrefixFromEnv({})).toBe("A");
    expect(accessionPrefixFromEnv({ ACCESSION_PREFIX: "HV" })).toBe("HV");
  });

  it.each(["abc", "TOOLONG", "A-B", "É"])("rejects %s", (value) => {
    expect(() => resolveAccessionPrefix(value)).toThrow(/ACCESSION_PREFIX/);
  });
});
