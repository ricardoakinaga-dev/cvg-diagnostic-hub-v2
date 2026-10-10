import { readFileSync } from "node:fs";

/**
 * PROD-302: secrets as files. For every variable `NAME_FILE` the process reads the file (Docker secret, mounted
 * read-only under /run/secrets) and exposes its content as `NAME`, so the rest of the code keeps reading
 * `process.env.NAME` and no secret has to live in an env file, in the Compose interpolation or in the build host.
 *
 * Rules, each one tested:
 * - `NAME` and `NAME_FILE` both set with different values: refused (two sources of truth). Equal values are
 *   accepted so the loader is idempotent (app instrumentation and scripts may both call it).
 * - a missing or unreadable file is refused: a secret that silently falls back to empty would start the
 *   service in a broken state.
 * - the trailing newline an editor leaves is trimmed; nothing else is touched.
 * - an empty file means "unset" (optional secrets such as POSTGRES_BACKUP_PASSWORD).
 * - connection strings may carry `${NAME}` placeholders (`DATABASE_URL`, `MIGRATION_DATABASE_URL`,
 *   `DATABASE_ADMIN_URL`): they are expanded after the files are read, with the password URL-encoded; an
 *   unknown placeholder is refused.
 * - only the variables named in `FILE_SECRET_VARIABLES` are secrets. Any other `*_FILE` variable (a path the
 *   process writes, such as `OUTBOX_HEARTBEAT_FILE`, or a tool's own configuration) is left alone: not read, not
 *   exported. The full restore rehearsal of 2026-10-10 (D-057) found the worker refusing to start because the
 *   loader tried to read its own heartbeat file before it existed. A new secret has to be added to the list; the
 *   test that scans the Compose files for `/run/secrets/` mounts fails until it is.
 */
export const FILE_SECRET_SUFFIX = "_FILE";
export const FILE_SECRET_VARIABLES = Object.freeze([
  "POSTGRES_PASSWORD_FILE",
  "POSTGRES_MIGRATION_PASSWORD_FILE",
  "POSTGRES_RUNTIME_PASSWORD_FILE",
  "POSTGRES_BACKUP_PASSWORD_FILE",
  "PGPASSWORD_FILE",
  "PGBACKUP_PASSWORD_FILE",
  "SESSION_SECRET_FILE",
  "TRUST_PROXY_SHARED_SECRET_FILE",
  "STORAGE_SECRET_KEY_FILE",
  "STORAGE_ROOT_PASSWORD_FILE",
  "OFFSITE_STORAGE_SECRET_KEY_FILE",
  "MALWARE_SCANNER_API_KEY_FILE",
  "METRICS_SCRAPE_TOKEN_FILE",
  "WHATSAPP_ACCESS_TOKEN_FILE",
  "WHATSAPP_APP_SECRET_FILE",
  "WHATSAPP_VERIFY_TOKEN_FILE",
  "OFFSITE_CRYPT_PASSWORD_FILE",
  "OFFSITE_CRYPT_SALT_FILE",
  "MINIO_ROOT_PASSWORD_FILE",
  "MINIO_KMS_SECRET_KEY_FILE",
  "RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY_FILE"
]);
export const TEMPLATE_VARIABLES = Object.freeze(["DATABASE_URL", "MIGRATION_DATABASE_URL", "DATABASE_ADMIN_URL"]);

export interface FileSecretsResult {
  /** Variables filled from files. */
  loaded: string[];
  /** Variables whose placeholders were expanded. */
  expanded: string[];
}

export interface FileSecretsOptions {
  readFile?: (path: string) => string;
}

export type SecretEnvironment = Record<string, string | undefined>;

export function loadFileSecrets(env: SecretEnvironment = process.env, options: FileSecretsOptions = {}): FileSecretsResult {
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const loaded: string[] = [];
  for (const [key, path] of Object.entries(env)) {
    if (!FILE_SECRET_VARIABLES.includes(key) || !path?.trim()) continue;
    const name = key.slice(0, -FILE_SECRET_SUFFIX.length);
    let content: string;
    try {
      content = read(path.trim());
    } catch (error) {
      throw new Error(`SECRET_FILE_UNREADABLE:${name}: ${key} aponta para um arquivo que não pode ser lido.`, { cause: error });
    }
    const value = content.replace(/\r?\n$/, "");
    const current = env[name];
    if (current !== undefined && current !== "" && current !== value) {
      throw new Error(`SECRET_CONFLICT:${name}: ${name} e ${key} definidos com valores diferentes; use só um.`);
    }
    if (value === "") delete env[name];
    else env[name] = value;
    loaded.push(name);
  }
  const expanded: string[] = [];
  for (const name of TEMPLATE_VARIABLES) {
    const template = env[name];
    if (!template || !template.includes("${")) continue;
    env[name] = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, variable: string) => {
      const value = env[variable];
      if (value === undefined || value === "") throw new Error(`SECRET_TEMPLATE_UNRESOLVED:${name}: ${variable} não definido para expandir ${name}.`);
      return encodeURIComponent(value);
    });
    expanded.push(name);
  }
  return { loaded: loaded.sort(), expanded };
}
