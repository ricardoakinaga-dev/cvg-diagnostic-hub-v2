import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFileSecrets } from "./file-secrets";

const files = new Map<string, string>();
const readFile = (file: string): string => {
  const content = files.get(file);
  if (content === undefined) throw new Error("ENOENT");
  return content;
};

describe("file secrets (PROD-302)", () => {
  beforeEach(() => files.clear());

  it("fills NAME from NAME_FILE, trims the trailing newline and reports what it loaded", () => {
    files.set("/run/secrets/session_secret", "s3cr3t-value-with-32-characters-minimum\n");
    files.set("/run/secrets/scanner_key", "\r\nkeep-leading\r\n");
    const env: Record<string, string | undefined> = { SESSION_SECRET_FILE: "/run/secrets/session_secret", MALWARE_SCANNER_API_KEY_FILE: " /run/secrets/scanner_key ", OTHER: "x" };

    const result = loadFileSecrets(env, { readFile });

    expect(env.SESSION_SECRET).toBe("s3cr3t-value-with-32-characters-minimum");
    expect(env.MALWARE_SCANNER_API_KEY).toBe("\r\nkeep-leading");
    expect(env.OTHER).toBe("x");
    expect(result).toEqual({ loaded: ["MALWARE_SCANNER_API_KEY", "SESSION_SECRET"], expanded: [] });
  });

  it("refuses NAME and NAME_FILE set to different values (two sources of truth)", () => {
    files.set("/run/secrets/session_secret", "from-file");
    const env: Record<string, string | undefined> = { SESSION_SECRET: "from-env", SESSION_SECRET_FILE: "/run/secrets/session_secret" };
    expect(() => loadFileSecrets(env, { readFile })).toThrow(/SECRET_CONFLICT:SESSION_SECRET/);
    expect(env.SESSION_SECRET).toBe("from-env");
  });

  it("is idempotent: a second call with the same value already in place is accepted", () => {
    files.set("/run/secrets/session_secret", "same\n");
    const env: Record<string, string | undefined> = { SESSION_SECRET_FILE: "/run/secrets/session_secret" };
    loadFileSecrets(env, { readFile });
    expect(() => loadFileSecrets(env, { readFile })).not.toThrow();
    expect(env.SESSION_SECRET).toBe("same");
  });

  it("refuses a missing or unreadable file instead of starting without the secret", () => {
    const env: Record<string, string | undefined> = { POSTGRES_RUNTIME_PASSWORD_FILE: "/run/secrets/absent" };
    expect(() => loadFileSecrets(env, { readFile })).toThrow(/SECRET_FILE_UNREADABLE:POSTGRES_RUNTIME_PASSWORD/);
    expect(env.POSTGRES_RUNTIME_PASSWORD).toBeUndefined();
  });

  it("treats an empty file as unset (optional secrets) and ignores empty NAME_FILE values", () => {
    files.set("/run/secrets/backup", "\n");
    const env: Record<string, string | undefined> = { POSTGRES_BACKUP_PASSWORD: "", POSTGRES_BACKUP_PASSWORD_FILE: "/run/secrets/backup", METRICS_SCRAPE_TOKEN_FILE: "", _FILE: "/x" };
    const result = loadFileSecrets(env, { readFile });
    expect(env.POSTGRES_BACKUP_PASSWORD).toBeUndefined();
    expect(env.METRICS_SCRAPE_TOKEN).toBeUndefined();
    expect(result.loaded).toEqual(["POSTGRES_BACKUP_PASSWORD"]);
  });

  it("expands ${NAME} placeholders in connection strings after reading the files, URL-encoding the value", () => {
    files.set("/run/secrets/runtime", "p@ss:word/with#chars\n");
    files.set("/run/secrets/migrator", "ddl-secret");
    const env: Record<string, string | undefined> = {
      POSTGRES_RUNTIME_PASSWORD_FILE: "/run/secrets/runtime",
      POSTGRES_MIGRATION_PASSWORD_FILE: "/run/secrets/migrator",
      POSTGRES_PASSWORD: "admin-from-env",
      DATABASE_URL: "postgresql://cvg_runtime:${POSTGRES_RUNTIME_PASSWORD}@postgres:5432/cvg",
      MIGRATION_DATABASE_URL: "postgresql://cvg_migrator:${POSTGRES_MIGRATION_PASSWORD}@postgres:5432/cvg",
      DATABASE_ADMIN_URL: "postgresql://cvg:${POSTGRES_PASSWORD}@postgres:5432/cvg",
      OTHER_URL: "keep ${POSTGRES_RUNTIME_PASSWORD} literal"
    };

    const result = loadFileSecrets(env, { readFile });

    expect(env.DATABASE_URL).toBe("postgresql://cvg_runtime:p%40ss%3Aword%2Fwith%23chars@postgres:5432/cvg");
    expect(new URL(env.DATABASE_URL!).password).toBe("p%40ss%3Aword%2Fwith%23chars");
    expect(decodeURIComponent(new URL(env.DATABASE_URL!).password)).toBe("p@ss:word/with#chars");
    expect(env.MIGRATION_DATABASE_URL).toBe("postgresql://cvg_migrator:ddl-secret@postgres:5432/cvg");
    expect(env.DATABASE_ADMIN_URL).toBe("postgresql://cvg:admin-from-env@postgres:5432/cvg");
    expect(env.OTHER_URL).toBe("keep ${POSTGRES_RUNTIME_PASSWORD} literal");
    expect(result.expanded).toEqual(["DATABASE_URL", "MIGRATION_DATABASE_URL", "DATABASE_ADMIN_URL"]);
  });

  it("refuses a connection string whose placeholder has no value", () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: "postgresql://cvg_runtime:${POSTGRES_RUNTIME_PASSWORD}@postgres:5432/cvg" };
    expect(() => loadFileSecrets(env, { readFile })).toThrow(/SECRET_TEMPLATE_UNRESOLVED:DATABASE_URL: POSTGRES_RUNTIME_PASSWORD/);
  });

  it("leaves a plain connection string and an environment without *_FILE untouched", () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: "postgresql://cvg_runtime:plain@postgres:5432/cvg", SESSION_SECRET: "env-only" };
    expect(loadFileSecrets(env, { readFile })).toEqual({ loaded: [], expanded: [] });
    expect(env.DATABASE_URL).toBe("postgresql://cvg_runtime:plain@postgres:5432/cvg");
  });

  it("reads real files from disk by default", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cvg-secrets-"));
    try {
      writeFileSync(path.join(dir, "trust"), "proxy-shared-secret-of-32-characters!\n", { mode: 0o600 });
      const env: Record<string, string | undefined> = { TRUST_PROXY_SHARED_SECRET_FILE: path.join(dir, "trust") };
      loadFileSecrets(env);
      expect(env.TRUST_PROXY_SHARED_SECRET).toBe("proxy-shared-secret-of-32-characters!");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterEach(() => files.clear());
