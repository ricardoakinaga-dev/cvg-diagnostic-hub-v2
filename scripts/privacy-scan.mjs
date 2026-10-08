#!/usr/bin/env node
// PROD-504: no real personal data and no secret in the repository, in the
// client bundle or in application logs. The secret scan (scripts/secret-scan.sh)
// covers credential formats in source; this scan covers personal identifiers,
// server-only configuration in the browser bundle, and what logs may contain.
//
//   node scripts/privacy-scan.mjs                  # tracked files (fixtures, tests, docs, config)
//   node scripts/privacy-scan.mjs --bundle <dir>   # built client assets, e.g. .next/static
//   node scripts/privacy-scan.mjs --logs <path>... # application logs from a real run
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Reserved for documentation and testing (RFC 2606/6761) or private to this project. */
const SYNTHETIC_EMAIL_DOMAIN = /(?:^|\.)(?:local|localhost|example|invalid|test)$|^example\.(?:org|com|net)$|\.example\.(?:org|com|net)$/i;
// `host` is the placeholder the redaction tests use; `${...}` is a Compose variable.
const LOOPBACK_OR_SYNTHETIC_HOST = /^(?:localhost|host|127\.0\.0\.1|\[::1\]|postgres|db|\$\{[^}]+\}|[a-z0-9.-]+\.(?:local|localhost|example|invalid|test))$|^(?:[a-z0-9-]+\.)*example\.(?:org|com|net)$/i;
const SERVER_ONLY_SETTINGS = ["SESSION_SECRET", "TRUST_PROXY_SHARED_SECRET", "DATABASE_URL", "MIGRATION_DATABASE_URL", "DATABASE_ADMIN_URL", "STORAGE_SECRET_KEY", "STORAGE_ACCESS_KEY", "MALWARE_SCANNER_API_KEY", "METRICS_SCRAPE_TOKEN", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "DEMO_PASSWORD", "BOOTSTRAP_ADMIN_PASSWORD", "POSTGRES_PASSWORD"];

const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g;
const PHONE_BR = /\(\d{2}\)\s?9?\d{4}-\d{4}\b/g;
const CONNECTION_WITH_PASSWORD = /\bpostgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@(\[[0-9A-Fa-f:.]+\]|[^\s/:?#'"`]+)/g;
const SESSION_COOKIE = /\bcvg_session=[A-Za-z0-9_-]{20,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g;

const SKIPPED_FILES = new Set(["package-lock.json"]);
const SKIPPED_PREFIXES = ["vendor/", "tests/e2e/visual.spec.ts-snapshots/", ".gauntlet/", ".orchestrate/"];
const TEXT_EXTENSION = /\.(?:[cm]?[jt]sx?|json|ya?ml|md|sql|sh|css|html|txt|env|example|conf|toml|Dockerfile)$|(?:^|\/)(?:Dockerfile|Caddyfile|\.env\.[a-z.]+)$/;

export function findingsFor(text, mode) {
  const findings = [];
  const add = (kind, match) => findings.push({ kind, match: match.length > 80 ? `${match.slice(0, 77)}...` : match });
  for (const [match, domain] of text.matchAll(EMAIL)) {
    // Logs must not carry identities at all; elsewhere only reserved domains are allowed.
    if (mode === "logs" || !SYNTHETIC_EMAIL_DOMAIN.test(domain)) add("email", match);
  }
  for (const [match] of text.matchAll(CPF)) add("cpf", match);
  for (const [match] of text.matchAll(CNPJ)) add("cnpj", match);
  for (const [match] of text.matchAll(PHONE_BR)) add("phone", match);
  for (const [match, host] of text.matchAll(CONNECTION_WITH_PASSWORD)) {
    if (mode !== "source" || !LOOPBACK_OR_SYNTHETIC_HOST.test(host)) add("connection-string", match);
  }
  if (mode !== "source") {
    for (const [match] of text.matchAll(SESSION_COOKIE)) add("session-cookie", match);
    for (const [match] of text.matchAll(BEARER)) add("bearer-token", match);
  }
  if (mode === "bundle") {
    for (const name of SERVER_ONLY_SETTINGS) if (text.includes(name)) add("server-setting", name);
  }
  return findings;
}

function trackedFiles() {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  return listed.filter((file) => !SKIPPED_FILES.has(path.basename(file)) && !SKIPPED_PREFIXES.some((prefix) => file.startsWith(prefix)) && TEXT_EXTENSION.test(file));
}

function filesUnder(target) {
  const stats = statSync(target);
  if (stats.isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => filesUnder(path.join(target, entry.name)));
}

export function scan(mode, targets) {
  const files = mode === "source" ? trackedFiles().map((file) => path.join(ROOT, file)) : targets.flatMap(filesUnder);
  if (files.length === 0) throw new Error(`privacy-scan: nothing to scan for ${mode} (${targets.join(", ") || "tracked files"}).`);
  const report = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const finding of findingsFor(text, mode)) report.push({ file: path.relative(ROOT, file), ...finding });
  }
  return { mode, scanned: files.length, findings: report };
}

function main(argv) {
  const mode = argv.includes("--bundle") ? "bundle" : argv.includes("--logs") ? "logs" : "source";
  const targets = argv.filter((argument) => !argument.startsWith("--")).map((target) => path.resolve(target));
  if (mode !== "source" && targets.length === 0) throw new Error(`privacy-scan: --${mode} needs at least one path.`);
  const result = scan(mode, targets);
  for (const finding of result.findings) console.error(`${finding.file}: ${finding.kind}: ${finding.match}`);
  console.log(`Privacy scan (${mode}): ${result.scanned} files, ${result.findings.length} findings.`);
  return result.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
