import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findingsFor, scan } from "./privacy-scan.mjs";

const kinds = (text, mode) => findingsFor(text, mode).map(({ kind }) => kind);

test("source allows reserved e-mail domains and loopback credentials only", () => {
  assert.deepEqual(kinds("vet@cvg.local admin@hospital.example.org a@b.invalid c@d.test e@f.example", "source"), []);
  assert.deepEqual(kinds("pessoa@gmail.com contato@hospital.com.br", "source"), ["email", "email"]);
  assert.deepEqual(kinds("postgresql://cvg:secret@127.0.0.1:5432/db postgres://u:p@[::1]/x postgres://u:p@postgres:5432 postgres://u:p@${HOST}", "source"), []);
  // A real host also reads as an e-mail address: both findings are reported.
  assert.deepEqual(kinds("postgresql://cvg:secret@db.hospital.org.br:5432/cvg", "source"), ["email", "connection-string"]);
});

test("personal identifiers are reported everywhere", () => {
  for (const mode of ["source", "bundle", "logs"]) {
    assert.deepEqual(kinds("CPF 123.456.789-09 CNPJ 12.345.678/0001-90 tel (11) 98765-4321", mode), ["cpf", "cnpj", "phone"], mode);
  }
});

test("logs may not carry any e-mail, session cookie or bearer token", () => {
  assert.deepEqual(kinds('{"event":"login","email":"vet@cvg.local"}', "logs"), ["email"]);
  assert.deepEqual(kinds("cookie: cvg_session=abcdefghijklmnopqrstuvwxyz012345", "logs"), ["session-cookie"]);
  assert.deepEqual(kinds("authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", "logs"), ["bearer-token"]);
  assert.deepEqual(kinds('{"event":"http.request","route":"/api/v1/session/me","status":200}', "logs"), []);
});

test("the client bundle may not name server-only settings", () => {
  assert.deepEqual(kinds("process.env.SESSION_SECRET", "bundle"), ["server-setting"]);
  assert.deepEqual(kinds('placeholder:"nome@hospital.example"', "bundle"), []);
});

test("scans files under a directory and refuses an empty target", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "privacy-scan-"));
  try {
    mkdirSync(path.join(root, "chunks"));
    writeFileSync(path.join(root, "chunks", "a.js"), "const ok = 1;");
    writeFileSync(path.join(root, "chunks", "b.js"), "const leaked = 'DATABASE_URL';");
    const result = scan("bundle", [root]);
    assert.equal(result.scanned, 2);
    assert.deepEqual(result.findings.map(({ kind, match }) => [kind, match]), [["server-setting", "DATABASE_URL"]]);
    const empty = path.join(root, "empty");
    mkdirSync(empty);
    assert.throws(() => scan("logs", [empty]), /nothing to scan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
