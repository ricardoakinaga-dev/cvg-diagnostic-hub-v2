#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_COLUMNS = Object.freeze([
  "requirement",
  "acceptance criterion",
  "code",
  "test",
  "command",
  "evidence"
]);

const requirementPattern = /\b(?:FR|NFR)-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;
const acceptancePattern = /\bAC-(?:FR|NFR)-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;
const sourcePathPattern = /\.(?:ts|tsx|js|jsx|mjs|cjs|sql|sh)$/i;
const placeholderPattern = /^(?:-|—|–|n\/a|na|none|todo|tbd|planned|pending)$/i;
const localEvidencePrefixes = [".orchestrate/evidence/", "evidence/", "artifacts/", "reports/"];

function normalizeColumn(value) {
  return value
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  const body = trimmed.slice(1).endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  return body.split("|").map((cell) => cell.trim());
}

function isTableLine(line) {
  return line.trim().startsWith("|");
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

export function parseMatrixTable(matrixText) {
  const lines = matrixText.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+3\.\s+Matrix\s*$/.test(line.trim()));
  const errors = [];
  if (headingIndex < 0) {
    return { headers: [], rows: [], errors: [{ code: "MATRIX_TABLE_MISSING", line: 0, message: "docs/TRACEABILITY_MATRIX.md must contain a `## 3. Matrix` table." }] };
  }

  let headerIndex = headingIndex + 1;
  while (headerIndex < lines.length && lines[headerIndex].trim() === "") headerIndex += 1;
  if (!isTableLine(lines[headerIndex])) {
    return { headers: [], rows: [], errors: [{ code: "MATRIX_HEADER_MISSING", line: headerIndex + 1, message: "the matrix heading must be followed by a Markdown table." }] };
  }

  const headers = parseMarkdownRow(lines[headerIndex]);
  const separator = parseMarkdownRow(lines[headerIndex + 1] ?? "");
  if (!isSeparatorRow(separator)) {
    errors.push({ code: "MATRIX_SEPARATOR_MISSING", line: headerIndex + 2, message: "the matrix header must have a Markdown separator row." });
  }

  const rows = [];
  let rowIndex = headerIndex + 2;
  while (rowIndex < lines.length && isTableLine(lines[rowIndex])) {
    const cells = parseMarkdownRow(lines[rowIndex]);
    if (isSeparatorRow(cells)) {
      rowIndex += 1;
      continue;
    }
    if (cells.length !== headers.length) {
      errors.push({
        code: "MATRIX_ROW_SHAPE_INVALID",
        line: rowIndex + 1,
        message: `matrix row has ${cells.length} cells but the header has ${headers.length}.`
      });
    } else {
      rows.push({ line: rowIndex + 1, cells });
    }
    rowIndex += 1;
  }

  return { headers, rows, errors };
}

export function parsePrdRequirements(prdText) {
  const requirements = new Map();
  const lines = prdText.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\|\s*((?:FR|NFR)-[A-Z0-9]+(?:-[A-Z0-9]+)+)\s*\|([^|]*)\|([^|]*)\|/);
    if (!match) continue;
    requirements.set(match[1], {
      id: match[1],
      priority: match[3].trim(),
      line: index + 1
    });
  }
  return requirements;
}

export function parseAcceptanceCriteria(prdText) {
  return new Set(prdText.match(acceptancePattern) ?? []);
}

function idsInCell(cell, pattern) {
  return [...new Set(cell.match(pattern) ?? [])];
}

function columnIndex(headers, names) {
  const wanted = new Set(names.map(normalizeColumn));
  return headers.findIndex((header) => wanted.has(normalizeColumn(header)));
}

function isWithinRoot(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function stripReferenceDecorators(value) {
  return value
    .trim()
    .replace(/^<|>$/g, "")
    .split("#", 1)[0]
    .split("?", 1)[0]
    .replace(/(?:::.*|:\d+)$/, "")
    .replace(/[.,;]+$/, "");
}

function looksLikeRepositoryPath(value) {
  return /^(?:\.\.?\/)?(?:src|packages|scripts|tests|db|\.orchestrate|evidence|artifacts|reports)\//.test(value);
}

function extractFileReferences(cell) {
  const references = [];
  const add = (raw) => {
    const candidate = stripReferenceDecorators(raw);
    if (!candidate || /^https?:\/\//i.test(candidate) || !looksLikeRepositoryPath(candidate)) return;
    for (const part of candidate.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)) {
      if (looksLikeRepositoryPath(part)) references.push(part);
    }
  };

  for (const match of cell.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) add(match[1]);
  for (const match of cell.matchAll(/`([^`]+)`/g)) add(match[1]);
  const barePattern = /(?:^|[\s,(;])((?:\.\.?\/)?(?:src|packages|scripts|tests|db|\.orchestrate|evidence|artifacts|reports)\/[^\s,;|)`]+)/g;
  for (const match of cell.matchAll(barePattern)) add(match[1]);
  return [...new Set(references)];
}

function resolveReference(reference, rootDir, matrixPath) {
  const base = reference.startsWith(".") ? path.dirname(matrixPath) : rootDir;
  return path.resolve(base, reference);
}

function readRegularFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return undefined;
    return readFileSync(candidate, "utf8");
  } catch {
    return undefined;
  }
}

function sourceLooksExecutable(relative, source) {
  if (!sourcePathPattern.test(relative) || source.trim().length === 0) return false;
  if (relative.endsWith(".sql")) return /\b(?:create|alter|insert|update|delete|select)\b/i.test(source);
  if (relative.endsWith(".sh")) return /(?:^#!|\b(?:npm|node|bash|sh|psql|pg_dump)\b)/m.test(source);
  return /\b(?:export|function|class|const|let|var|interface|type|async)\b/.test(source);
}

function testLooksExecutable(relative, source) {
  const isTestPath = /(?:\.test\.|\.spec\.)/i.test(path.basename(relative)) || relative.startsWith("tests/");
  if (!isTestPath) return { ok: false, reason: "test reference must point to a *.test.*/*.spec.* file or tests/**" };
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  if (!/\b(?:test|it|describe)\s*\(/.test(withoutComments)) {
    return { ok: false, reason: "test file has no executable test/it/describe declaration" };
  }
  if (!/\b(?:expect|assert(?:\.[A-Za-z]+)?|strictEqual|deepEqual|toEqual|toBe|toThrow|ok)\b/.test(withoutComments)) {
    return { ok: false, reason: "test file has no executable assertion" };
  }
  return { ok: true };
}

function commandText(cell) {
  return cell
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstCommandSegment(cell) {
  return commandText(cell).split(/\s*(?:&&|\|\||;)\s*/, 1)[0].trim();
}

function commandSignature(cell) {
  const segment = firstCommandSegment(cell).replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "");
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens[0] === "npm" && tokens[1] === "run") return tokens.slice(0, 3).join(" ");
  if (tokens[0] === "npm") return tokens.slice(0, 2).join(" ");
  return tokens.slice(0, 2).join(" ");
}

function commandIsLocal(cell) {
  const command = commandText(cell);
  if (!command || placeholderPattern.test(command)) return false;
  if (/\b(?:curl|wget|ssh|scp)\b|\bgit\s+(?:clone|fetch|pull|push|remote)\b|https?:\/\//i.test(command)) return false;
  return /(?:^|\s)(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:npm|node|npx|tsx|vitest|tsc|eslint|bash|sh|git)\b/.test(command);
}

function evidenceHasCommand(evidence, command) {
  const signature = commandSignature(command);
  if (!signature) return false;
  return evidence.replace(/\s+/g, " ").includes(signature);
}

function addIssue(issues, code, message, line = 0) {
  issues.push({ code, message, line });
}

function rowLabel(row, columns) {
  const requirements = columns.requirement >= 0 ? idsInCell(row.cells[columns.requirement], requirementPattern) : [];
  const criteria = columns.acceptance >= 0 ? idsInCell(row.cells[columns.acceptance], acceptancePattern) : [];
  return [...requirements, ...criteria].join(", ") || `matrix line ${row.line}`;
}

function validatePathCell({ issues, row, label, cell, rootDir, matrixPath, kind, command }) {
  const references = extractFileReferences(cell);
  if (references.length === 0) {
    addIssue(issues, `${kind.toUpperCase()}_REFERENCE_MISSING`, `${label}: ${kind} must contain a repository file link/path; an ID or status alone is not evidence.`, row.line);
    return;
  }

  for (const reference of references) {
    const candidate = resolveReference(reference, rootDir, matrixPath);
    const relative = path.relative(rootDir, candidate).split(path.sep).join("/");
    if (!isWithinRoot(rootDir, candidate)) {
      addIssue(issues, "REFERENCE_OUTSIDE_REPOSITORY", `${label}: ${reference} resolves outside the repository.`, row.line);
      continue;
    }
    const content = readRegularFile(candidate);
    if (content === undefined) {
      addIssue(issues, "REFERENCE_NOT_FOUND", `${label}: linked ${kind} file does not exist: ${relative}.`, row.line);
      continue;
    }

    if (kind === "code") {
      if (!/^(?:src|packages|scripts|db)\//.test(relative)) {
        addIssue(issues, "CODE_REFERENCE_OUTSIDE_SOURCE", `${label}: code must point into src/, packages/, scripts/ or db/: ${relative}.`, row.line);
      } else if (/\.test\.|\.spec\./i.test(path.basename(relative))) {
        addIssue(issues, "CODE_REFERENCE_IS_TEST", `${label}: code reference points to a test file: ${relative}.`, row.line);
      } else if (!sourceLooksExecutable(relative, content)) {
        addIssue(issues, "CODE_REFERENCE_NOT_EXECUTABLE", `${label}: linked code file has no recognizable implementation: ${relative}.`, row.line);
      }
    } else if (kind === "test") {
      const result = testLooksExecutable(relative, content);
      if (!result.ok) addIssue(issues, "TEST_REFERENCE_NOT_EXECUTABLE", `${label}: ${relative} ${result.reason}.`, row.line);
    } else {
      if (!localEvidencePrefixes.some((prefix) => relative.startsWith(prefix))) {
        addIssue(issues, "EVIDENCE_REFERENCE_NOT_LOCAL", `${label}: evidence must be under .orchestrate/evidence/, evidence/, artifacts/ or reports/: ${relative}.`, row.line);
      }
      if (!/\b20\d{2}-\d{2}-\d{2}\b/.test(content)) {
        addIssue(issues, "EVIDENCE_DATE_MISSING", `${label}: evidence must contain an ISO date so stale records are visible: ${relative}.`, row.line);
      }
      if (!/\b(?:PASS|FAIL|BLOCKED|CONDITIONAL|NOT VERIFIED)\b/i.test(content)) {
        addIssue(issues, "EVIDENCE_RESULT_MISSING", `${label}: evidence must record a result such as PASS, FAIL or BLOCKED: ${relative}.`, row.line);
      }
      if (!evidenceHasCommand(content, command)) {
        addIssue(issues, "EVIDENCE_COMMAND_MISSING", `${label}: evidence does not contain the command signature from the matrix: ${commandSignature(command) || "<missing>"}.`, row.line);
      }
    }
  }
}

function validateCommandCell({ issues, row, label, cell }) {
  if (!commandIsLocal(cell)) {
    addIssue(issues, "COMMAND_NOT_LOCAL_OR_MISSING", `${label}: command must be a non-placeholder local command (npm/node/tsx/vitest/tsc/eslint/bash/sh/git).`, row.line);
  }
}

function sortIssues(issues) {
  return [...issues].sort((left, right) => left.line - right.line || left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
}

export function validateTraceability({ rootDir, matrixPath, prdPath } = {}) {
  const resolvedRoot = path.resolve(rootDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const resolvedMatrixPath = path.resolve(matrixPath ?? path.join(resolvedRoot, "docs/TRACEABILITY_MATRIX.md"));
  const resolvedPrdPath = path.resolve(prdPath ?? path.join(resolvedRoot, "docs/prd/PRD.md"));
  const matrixText = readFileSync(resolvedMatrixPath, "utf8");
  const prdText = readFileSync(resolvedPrdPath, "utf8");
  const matrix = parseMatrixTable(matrixText);
  const requirements = parsePrdRequirements(prdText);
  const acceptanceCriteria = parseAcceptanceCriteria(prdText);
  const issues = [...matrix.errors];

  if (requirements.size === 0) addIssue(issues, "PRD_REQUIREMENTS_MISSING", "PRD has no FR-/NFR- requirement table rows.");
  if (acceptanceCriteria.size === 0) addIssue(issues, "PRD_ACCEPTANCE_CRITERIA_MISSING", "PRD has no AC-FR-/AC-NFR- acceptance criteria.");
  if (matrix.rows.length === 0) addIssue(issues, "MATRIX_ROWS_MISSING", "the traceability matrix has no data rows.");

  const columns = {
    requirement: columnIndex(matrix.headers, ["requirement"]),
    acceptance: columnIndex(matrix.headers, ["acceptance criterion", "acceptance criteria"]),
    code: columnIndex(matrix.headers, ["code", "implementation", "implementation surface"]),
    test: columnIndex(matrix.headers, ["test", "test file", "test evidence"]),
    command: columnIndex(matrix.headers, ["command", "verification command", "executable command"]),
    evidence: columnIndex(matrix.headers, ["evidence", "fresh evidence", "evidence artifact"])
  };
  for (const requiredColumn of REQUIRED_COLUMNS) {
    const key = requiredColumn === "acceptance criterion" ? "acceptance" : requiredColumn;
    if (columns[key] < 0) addIssue(issues, "MATRIX_MISSING_COLUMN", `matrix must contain a separate \`${requiredColumn}\` column; ID-only planning fields do not prove evidence.`);
  }

  const completeSchema = REQUIRED_COLUMNS.every((requiredColumn) => {
    const key = requiredColumn === "acceptance criterion" ? "acceptance" : requiredColumn;
    return columns[key] >= 0;
  });
  if (!completeSchema) {
    return {
      ok: false,
      issues: sortIssues(issues),
      requirements: [...requirements.keys()],
      acceptanceCriteria: [...acceptanceCriteria]
    };
  }

  const requirementRows = new Map();
  const acceptanceRows = new Map();
  const knownRequirements = new Set(requirements.keys());
  for (const row of matrix.rows) {
    const rowRequirements = idsInCell(row.cells[columns.requirement], requirementPattern);
    const rowCriteria = idsInCell(row.cells[columns.acceptance], acceptancePattern);
    if (rowRequirements.length === 0 && rowCriteria.length === 0) {
      addIssue(issues, "MATRIX_ROW_UNIDENTIFIED", `matrix row has no exact FR-/NFR- requirement or AC- identifier: ${rowLabel(row, columns)}.`, row.line);
      continue;
    }
    for (const id of rowRequirements) {
      if (!knownRequirements.has(id)) addIssue(issues, "UNKNOWN_REQUIREMENT", `matrix references requirement not declared in PRD: ${id}.`, row.line);
      if (!requirementRows.has(id)) requirementRows.set(id, []);
      requirementRows.get(id).push(row);
    }
    for (const id of rowCriteria) {
      if (!acceptanceCriteria.has(id)) addIssue(issues, "UNKNOWN_ACCEPTANCE_CRITERION", `matrix references acceptance criterion not declared in PRD: ${id}.`, row.line);
      if (!acceptanceRows.has(id)) acceptanceRows.set(id, []);
      acceptanceRows.get(id).push(row);
    }
  }

  for (const requirement of requirements.values()) {
    const rows = requirementRows.get(requirement.id) ?? [];
    if (rows.length === 0) {
      addIssue(issues, requirement.priority === "MUST" ? "MUST_REQUIREMENT_ROW_MISSING" : "REQUIREMENT_ROW_MISSING", `${requirement.id} (${requirement.priority}) has no exact row in the matrix.`, requirement.line);
    } else if (rows.length > 1) {
      addIssue(issues, "REQUIREMENT_ROW_DUPLICATED", `${requirement.id} appears in ${rows.length} matrix rows; evidence ownership is ambiguous.`, rows[0].line);
    }
  }
  for (const id of acceptanceCriteria) {
    const rows = acceptanceRows.get(id) ?? [];
    if (rows.length === 0) addIssue(issues, "AC_ROW_MISSING", `${id} has no exact row in the matrix.`);
    else if (rows.length > 1) addIssue(issues, "AC_ROW_DUPLICATED", `${id} appears in ${rows.length} matrix rows; evidence ownership is ambiguous.`, rows[0].line);
  }

  const evidenceRows = new Set([...requirementRows.values(), ...acceptanceRows.values()].flat());
  for (const row of evidenceRows) {
    const label = rowLabel(row, columns);
    const command = row.cells[columns.command];
    validateCommandCell({ issues, row, label, cell: command });
    validatePathCell({ issues, row, label, cell: row.cells[columns.code], rootDir: resolvedRoot, matrixPath: resolvedMatrixPath, kind: "code" });
    validatePathCell({ issues, row, label, cell: row.cells[columns.test], rootDir: resolvedRoot, matrixPath: resolvedMatrixPath, kind: "test" });
    validatePathCell({ issues, row, label, cell: row.cells[columns.evidence], rootDir: resolvedRoot, matrixPath: resolvedMatrixPath, kind: "evidence", command });
  }

  return {
    ok: issues.length === 0,
    issues: sortIssues(issues),
    requirements: [...requirements.keys()],
    acceptanceCriteria: [...acceptanceCriteria]
  };
}

function main() {
  try {
    const result = validateTraceability();
    if (!result.ok) {
      console.error(`Traceability validation FAILED with ${result.issues.length} issue(s).`);
      for (const issue of result.issues) console.error(`${issue.code}${issue.line ? ` (line ${issue.line})` : ""}: ${issue.message}`);
      return 1;
    }
    console.log(`Traceability validation PASS: ${result.requirements.length} requirements and ${result.acceptanceCriteria.length} acceptance criteria have linked code, test, command and current evidence.`);
    return 0;
  } catch (error) {
    console.error(`Traceability validation ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
