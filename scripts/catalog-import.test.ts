import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogImportExitCode, formatCatalogImportReport, parseCatalogImportArgs } from "./catalog-import";

test("parses services, analytes, apply and actor", () => {
  assert.deepEqual(parseCatalogImportArgs(["--services", "a.csv", "--actor", "Admin@CVG.local"]), { services: "a.csv", apply: false, actor: "admin@cvg.local" });
  assert.deepEqual(parseCatalogImportArgs(["--apply", "--services", "a.csv", "--analytes", "b.csv", "--actor", "m@cvg.local"]), { services: "a.csv", analytes: "b.csv", apply: true, actor: "m@cvg.local" });
});

test("rejects missing, unknown and valueless arguments in Portuguese", () => {
  assert.throws(() => parseCatalogImportArgs(["--actor", "a@b.c"]), /--services/);
  assert.throws(() => parseCatalogImportArgs(["--services", "a.csv"]), /--actor/);
  assert.throws(() => parseCatalogImportArgs(["--services", "a.csv", "--actor", "sem-arroba"]), /--actor/);
  assert.throws(() => parseCatalogImportArgs(["--services", "a.csv", "--actor", "a@b.c", "--force"]), /desconhecido: --force/);
  assert.throws(() => parseCatalogImportArgs(["--services", "--actor", "a@b.c"]), /exige um valor/);
  assert.throws(() => parseCatalogImportArgs(["--services"]), /exige um valor/);
});

test("formats the report table, outcome line and JSON summary", () => {
  const report = {
    rows: [
      { line: 2, code: "GLUCOSE", action: "CREATE" as const, changes: ["novo exame"] },
      { line: 3, code: "CRP", action: "UNCHANGED" as const },
      { line: 4, code: "", action: "ERROR" as const, errors: ["Cabeçalho inválido"] }
    ],
    summary: { create: 1, update: 0, unchanged: 1, error: 1 }
  };
  const text = formatCatalogImportReport(report, false);
  assert.match(text, /Linha\s+Código\s+Ação\s+Detalhes/);
  assert.match(text, /2\s+GLUCOSE\s+CRIAR\s+novo exame/);
  assert.match(text, /3\s+CRP\s+SEM MUDANÇA/);
  assert.match(text, /4\s+-\s+ERRO\s+Cabeçalho inválido/);
  assert.match(text, /Nada foi gravado: corrija/);
  assert.match(text, /\{"mode":"dry-run","create":1,"update":0,"unchanged":1,"error":1\}/);
  assert.equal(catalogImportExitCode(report), 1);

  const losing = { rows: [{ line: 2, code: "URINALYSIS", action: "UPDATE" as const, changes: ["analitos removidos: FIRST (obrigatório)"], removedAnalytes: [{ code: "FIRST", label: "Primeiro", required: true }] }], summary: { create: 0, update: 1, unchanged: 0, error: 0 } };
  const warned = formatCatalogImportReport(losing, false);
  assert.match(warned, /analitos removidos: FIRST \(obrigatório\)/);
  assert.match(warned, /Atenção: 1 exame perde analitos/);
  assert.match(formatCatalogImportReport({ ...losing, rows: [...losing.rows, ...losing.rows] }, false), /Atenção: 2 exames perdem analitos/);

  const ok = { rows: [{ line: 2, code: "A", action: "UPDATE" as const, changes: ["nome: x → y"] }], summary: { create: 0, update: 1, unchanged: 0, error: 0 } };
  assert.match(formatCatalogImportReport(ok, false), /Use --apply para aplicar/);
  assert.match(formatCatalogImportReport({ ...ok, applied: true }, true), /Importação aplicada\.\n\{"mode":"apply"/);
  assert.match(formatCatalogImportReport({ ...ok, applied: false }, true), /Nada foi gravado\./);
  assert.equal(catalogImportExitCode(ok), 0);
});
