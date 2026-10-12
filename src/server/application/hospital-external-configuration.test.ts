import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hospitalHisV4ConfigFromEnv, validateHospitalHisV4Config } from "./hospital-his-v4-config";
import { hospitalIntegrationHttpConfigFromEnv, validateHospitalIntegrationHttpConfig } from "./hospital-integration-http";
import { hisV4Config } from "../../test/hospital-his-v4-fixtures";
import { EXTERNAL_SECRET, externalConfig } from "../../test/hospital-external-fixtures";

describe("operator-owned external configuration files", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "cvg-external-config-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  function file(name: string, value = EXTERNAL_SECRET, mode = 0o600) { const path = join(directory, name); writeFileSync(path, value, { mode }); return path; }
  function hisEnv() { return { HOSPITAL_HIS_V4_ENABLED: "true", HOSPITAL_HIS_V4_CATALOG_ENDPOINT: "https://127.0.0.1/integrations/catalog", HOSPITAL_HIS_V4_ALLOWED_HOSTS: " 127.0.0.1, ", HOSPITAL_HIS_V4_ALLOWED_IPS: "127.0.0.1, ", HOSPITAL_HIS_V4_API_KEY_FILE: file("his-api-key"), HOSPITAL_HIS_V4_ACCOUNT_ID: "synthetic-account", HOSPITAL_HIS_V4_CONTRACT_REFERENCE: "synthetic-contract" }; }
  function cvgEnv() { return { HOSPITAL_INTEGRATION_HIS_ENABLED: "true", HOSPITAL_INTEGRATION_HIS_ENDPOINT: "https://127.0.0.1/contract", HOSPITAL_INTEGRATION_HIS_ALLOWED_HOSTS: "127.0.0.1", HOSPITAL_INTEGRATION_HIS_ALLOWED_IPS: "127.0.0.1", HOSPITAL_INTEGRATION_HIS_TOKEN_FILE: file("cvg-token"), HOSPITAL_INTEGRATION_HIS_HMAC_SECRET_FILE: file("cvg-hmac"), HOSPITAL_INTEGRATION_HIS_CONTRACT_REFERENCE: "synthetic-contract" }; }
  it("loads an explicit CA and timeout while retaining exact approved IPs for both profiles", () => {
    const ca = file("test-ca.pem", "synthetic configuration-only CA contents", 0o644);
    expect(hospitalHisV4ConfigFromEnv({ ...hisEnv(), HOSPITAL_HIS_V4_CA_FILE: ca, HOSPITAL_HIS_V4_TIMEOUT_MS: "5000" })).toMatchObject({ timeoutMs: 5000, ca: "synthetic configuration-only CA contents", allowedIps: ["127.0.0.1"] });
    expect(hospitalIntegrationHttpConfigFromEnv("HIS", { ...cvgEnv(), HOSPITAL_INTEGRATION_HIS_CA_FILE: ca })).toMatchObject({ timeoutMs: 10000, ca: "synthetic configuration-only CA contents" });
    expect(() => validateHospitalIntegrationHttpConfig({ ...externalConfig("HIS"), endpoint: "https://127.0.0.2/contract", allowedHosts: ["127.0.0.2"] })).toThrow(expect.objectContaining({ code: "INTEGRATION_CONFIGURATION_INVALID" }));
  });
  it("rejects nonabsolute, missing, nonfile or excessive CA paths before opening any connection", () => {
    const env = hisEnv(); const cvg = cvgEnv(); const oversized = file("large-ca", "x".repeat(100001));
    for (const path of ["relative-ca", join(directory, "missing-ca"), directory, oversized]) {
      expect(() => hospitalHisV4ConfigFromEnv({ ...env, HOSPITAL_HIS_V4_CA_FILE: path })).toThrow(expect.objectContaining({ code: "HIS_V4_CONFIGURATION_INVALID" }));
      expect(() => hospitalIntegrationHttpConfigFromEnv("HIS", { ...cvg, HOSPITAL_INTEGRATION_HIS_CA_FILE: path })).toThrow(expect.objectContaining({ code: "INTEGRATION_CONFIGURATION_INVALID" }));
    }
  });
  it("refuses short or relative transport secrets and a literal IP outside the approved HIS addresses", () => {
    const cvg = cvgEnv();
    expect(() => hospitalIntegrationHttpConfigFromEnv("HIS", { ...cvg, HOSPITAL_INTEGRATION_HIS_TOKEN_FILE: "relative-secret" })).toThrow(expect.objectContaining({ code: "INTEGRATION_CONFIGURATION_INVALID" }));
    expect(() => hospitalIntegrationHttpConfigFromEnv("HIS", { ...cvg, HOSPITAL_INTEGRATION_HIS_TOKEN_FILE: file("short-secret", "short") })).toThrow(expect.objectContaining({ code: "INTEGRATION_CONFIGURATION_INVALID" }));
    expect(() => validateHospitalHisV4Config({ ...hisV4Config(), endpoint: "https://127.0.0.2/api/integrations/catalog", allowedHosts: ["127.0.0.2"] })).toThrow(expect.objectContaining({ code: "HIS_V4_CONFIGURATION_INVALID" }));
  });
  it("does not accept malformed webhook identity or secrets even with an otherwise valid discovery profile", () => {
    const config = hisV4Config();
    for (const change of [{ secret: "short" }, { webhookId: "invalid whitespace" }, { credentialId: "" }, { credentialVersion: 0 }]) {
      expect(() => validateHospitalHisV4Config({ ...config, webhook: { ...config.webhook!, ...change } })).toThrow(expect.objectContaining({ code: "HIS_V4_CONFIGURATION_INVALID" }));
    }
  });
});
