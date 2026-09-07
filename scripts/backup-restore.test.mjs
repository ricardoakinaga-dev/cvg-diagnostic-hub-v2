import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function script(name) {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

test("the PostgreSQL backup script requires an explicit database and writes a custom dump", () => {
  const source = script("backup-db.sh");
  assert.match(source, /DATABASE_URL:\?[^}]+\}/);
  assert.match(source, /pg_dump --format=custom/);
  assert.match(source, /--file \"\$backup_file\"/);
  assert.match(source, /recovery-manifest\.ts create/);
  assert.match(source, /BACKUP_OBJECT_MANIFEST/);
});

test("restore is opt-in and keeps the dump path outside the command text", () => {
  const source = script("restore-db.sh");
  assert.match(source, /ALLOW_DB_RESTORE:\?[^}]+\}/);
  assert.match(source, /ALLOW_DB_RESTORE\" != \"true\"/);
  assert.match(source, /restore_file=\"\$\{1:\?/);
  assert.match(source, /pg_restore --clean --if-exists --no-owner --dbname \"\$DATABASE_URL\" \"\$restore_file\"/);
  assert.match(source, /manifesto de recuperação não encontrado/);
  assert.match(source, /recovery-manifest\.ts verify/);
});

test("the isolated restore smoke uses a disposable database and cleans it up", () => {
  const source = script("backup-restore-smoke.sh");
  assert.match(source, /ALLOW_DB_RESTORE_SMOKE:\?[^}]+\}/);
  assert.match(source, /smoke_db=\"cvg_restore_smoke_\$\{BASHPID\}\"/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /pg_dump --format=custom/);
  assert.match(source, /pg_restore --exit-on-error/);
  assert.match(source, /dropdb --if-exists/);
  assert.match(source, /recovery-manifest\.ts create/);
  assert.match(source, /recovery-manifest\.ts verify/);
  assert.match(source, /NOT_CAPTURED/);
  assert.match(source, /POSTGRES_DIRECT_URL/);
  assert.match(source, /CREATE DATABASE/);
  assert.match(source, /pg_restore_bin/);
});
