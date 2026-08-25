import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(entryPath) : entryPath;
  });
}

test("application architecture keeps production modules cohesive and the domain independent", () => {
  const productionFiles = sourceFiles(path.resolve(serverRoot, ".."))
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.test\.(ts|tsx)$/.test(file));
  const oversized = productionFiles
    .map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n").length }))
    .filter(({ lines }) => lines > 800);
  expect(oversized, "production source files must remain under the 800-line limit").toEqual([]);

  const domainFiles = sourceFiles(path.resolve(serverRoot, "domain"))
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.test\.(ts|tsx)$/.test(file));
  const forbiddenDomainImports = domainFiles.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return /from ["'][^"']*security\//.test(source) || /from ["'][^"']*app\//.test(source) ? [file] : [];
  });
  expect(forbiddenDomainImports, "domain modules must not depend on security or HTTP composition").toEqual([]);
});
