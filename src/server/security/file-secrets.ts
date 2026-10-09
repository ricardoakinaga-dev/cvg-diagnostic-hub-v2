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
 */
export const FILE_SECRET_SUFFIX = "_FILE";
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
    if (!key.endsWith(FILE_SECRET_SUFFIX) || key === FILE_SECRET_SUFFIX || !path?.trim()) continue;
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
