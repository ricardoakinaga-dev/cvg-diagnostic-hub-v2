import { describe, expect, it, vi } from "vitest";
import { formatHospitalDateTime, hospitalDateKey, hospitalDateTimeInput, hospitalDateTimeInputToIso, hospitalTimezone } from "./hospital-time";

describe("hospital wall-clock time", () => {
  it("converts the institutional wall clock to UTC regardless of the device timezone", () => {
    const previous = process.env.TZ;
    try {
      for (const tz of ["UTC", "Pacific/Honolulu", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        expect(hospitalDateTimeInputToIso("2026-10-11T09:30", "America/Sao_Paulo")).toBe("2026-10-11T12:30:00.000Z");
        expect(hospitalDateTimeInput("2026-10-11T12:30:00.000Z", "America/Sao_Paulo")).toBe("2026-10-11T09:30");
        expect(formatHospitalDateTime("2026-10-11T12:30:00.000Z", "America/Sao_Paulo")).toContain("09:30");
        expect(hospitalDateKey("2026-10-11T02:30:00.000Z", "America/Sao_Paulo")).toBe("2026-10-10");
      }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it("rejects impossible dates, DST gaps and ambiguous overlap instead of choosing silently", () => {
    for (const value of ["2026-02-30T12:00", "2026-10-11T25:00", "2026-10-11", "garbage", "2026-10-11T12:00Z"]) expect(() => hospitalDateTimeInputToIso(value)).toThrow();
    expect(() => hospitalDateTimeInputToIso("2026-03-08T02:30", "America/New_York")).toThrow("não existe");
    expect(() => hospitalDateTimeInputToIso("2026-11-01T01:30", "America/New_York")).toThrow("ambíguo");
    expect(hospitalDateTimeInputToIso("2026-11-01T03:00", "America/New_York")).toBe("2026-11-01T08:00:00.000Z");
  });
  it("validates configuration and handles missing timestamps", () => {
    vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "Asia/Kathmandu");
    expect(hospitalTimezone()).toBe("Asia/Kathmandu");
    expect(hospitalDateTimeInputToIso("2026-10-11T09:30", hospitalTimezone())).toBe("2026-10-11T03:45:00.000Z");
    expect(hospitalTimezone("invalid")).toBe("America/Sao_Paulo");
    expect(formatHospitalDateTime("invalid")).toBe("Não informado");
    expect(hospitalDateKey("invalid")).toBe("");
    vi.unstubAllEnvs();
  });
});
