import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(serverRoot, "../..");
const productionRoots = ["src/app", "src/components", "src/features", "src/server", "packages"];
const sourceExtension = /\.(ts|tsx)$/;
const testExtension = /\.(test|spec)\.(ts|tsx)$/;
const ignoredAssetExtension = /\.(css|scss|sass|less|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf)$/i;

type Layer =
  | "web"
  | "transport"
  | "application"
  | "server-domain"
  | "package-domain"
  | "http"
  | "security"
  | "store"
  | "storage"
  | "operations"
  | "observability"
  | "contracts"
  | "services"
  | "shared-state"
  | "ui";

interface ImportReference {
  specifier: string;
  typeOnly: boolean;
}

interface GraphEdge {
  importer: string;
  target: string;
  specifier: string;
  typeOnly: boolean;
}

interface ProductionGraph {
  files: string[];
  edges: GraphEdge[];
  adjacency: Map<string, string[]>;
  unresolved: string[];
  boundaryViolations: string[];
  cycles: string[][];
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return sourceExtension.test(entry.name) && !testExtension.test(entry.name) ? [entryPath] : [];
  });
}

function relativePath(file: string): string {
  return path.relative(repositoryRoot, file).split(path.sep).join("/");
}

function compilerOptions(): ts.CompilerOptions {
  const configPath = path.join(repositoryRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot);
  return {
    ...parsed.options,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler
  };
}

function importReferences(sourceFile: ts.SourceFile): ImportReference[] {
  const references: ImportReference[] = [];
  const add = (specifier: string, typeOnly: boolean): void => {
    references.push({ specifier, typeOnly });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node.isTypeOnly === true);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, false);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal.text, true);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      ((node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      add(node.arguments[0].text, false);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("@cvg/");
}

function layerFor(file: string): Layer {
  const relative = relativePath(file);
  if (relative.startsWith("src/app/api/")) return "transport";
  if (relative.startsWith("src/app/") || relative.startsWith("src/components/") || relative.startsWith("src/features/")) return "web";
  if (relative.startsWith("src/server/application/")) return "application";
  if (relative.startsWith("src/server/domain/")) return "server-domain";
  if (relative.startsWith("src/server/http/")) return "http";
  if (relative.startsWith("src/server/security/")) return "security";
  if (relative.startsWith("src/server/store/")) return "store";
  if (relative.startsWith("src/server/storage/")) return "storage";
  if (relative.startsWith("src/server/operations/")) return "operations";
  if (relative.startsWith("src/server/observability/")) return "observability";
  if (relative.startsWith("packages/contracts/")) return "contracts";
  if (relative.startsWith("packages/domain/")) return "package-domain";
  if (relative.startsWith("packages/services/")) return "services";
  if (relative.startsWith("packages/shared-state/")) return "shared-state";
  if (relative.startsWith("packages/ui/")) return "ui";
  throw new Error(`Unclassified production source file: ${relative}`);
}

const allowedTargets: Record<Layer, ReadonlySet<Layer>> = {
  web: new Set(["web", "contracts", "services", "shared-state", "ui"]),
  transport: new Set([
    "transport",
    "application",
    "server-domain",
    "package-domain",
    "http",
    "security",
    "store",
    "operations",
    "observability",
    "contracts"
  ]),
  application: new Set(["application", "server-domain", "package-domain", "contracts", "security", "http", "storage"]),
  "server-domain": new Set(["server-domain", "package-domain", "contracts"]),
  "package-domain": new Set(["package-domain", "contracts"]),
  http: new Set(["http", "contracts"]),
  security: new Set(["security", "server-domain", "contracts", "http"]),
  store: new Set(["store", "server-domain", "contracts", "security", "storage"]),
  storage: new Set(["storage"]),
  operations: new Set(["operations", "server-domain"]),
  observability: new Set(["observability", "server-domain"]),
  contracts: new Set(["contracts"]),
  services: new Set(["services", "contracts"]),
  "shared-state": new Set(["shared-state", "contracts"]),
  ui: new Set(["ui", "contracts"])
};

function stronglyConnectedComponents(nodes: string[], adjacency: Map<string, string[]>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const child of adjacency.get(node) ?? []) {
      if (!indices.has(child)) {
        visit(child);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(child)!));
      } else if (onStack.has(child)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(child)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let child: string;
    do {
      child = stack.pop()!;
      onStack.delete(child);
      component.push(child);
    } while (child !== node);
    components.push(component.sort());
  };

  for (const node of [...nodes].sort()) {
    if (!indices.has(node)) visit(node);
  }

  return components
    .filter((component) => component.length > 1 || (adjacency.get(component[0]) ?? []).includes(component[0]))
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function buildProductionGraph(): ProductionGraph {
  const files = productionRoots.flatMap((root) => sourceFiles(path.join(repositoryRoot, root))).map((file) => path.resolve(file)).sort();
  const fileSet = new Set(files);
  const options = compilerOptions();
  const edges: GraphEdge[] = [];
  const unresolved: string[] = [];

  for (const file of files) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const reference of importReferences(sourceFile)) {
      const resolved = ts.resolveModuleName(reference.specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved) {
        if (isLocalSpecifier(reference.specifier) && !ignoredAssetExtension.test(reference.specifier)) {
          unresolved.push(`${relativePath(file)} imports unresolved local module ${reference.specifier}`);
        }
        continue;
      }

      const target = path.resolve(resolved);
      if (fileSet.has(target)) {
        edges.push({
          importer: file,
          target,
          specifier: reference.specifier,
          typeOnly: reference.typeOnly
        });
      }
    }
  }

  const adjacency = new Map<string, string[]>(files.map((file) => [file, []]));
  for (const edge of edges) {
    const targets = adjacency.get(edge.importer)!;
    if (!targets.includes(edge.target)) targets.push(edge.target);
  }
  for (const targets of adjacency.values()) targets.sort();

  const boundaryViolations = edges
    .filter((edge) => !allowedTargets[layerFor(edge.importer)].has(layerFor(edge.target)))
    .map((edge) => {
      const fromLayer = layerFor(edge.importer);
      const toLayer = layerFor(edge.target);
      const edgeKind = edge.typeOnly ? "type import" : "runtime import";
      return `${relativePath(edge.importer)} (${fromLayer}) -> ${relativePath(edge.target)} (${toLayer}) via ${edge.specifier} [${edgeKind}]`;
    })
    .sort();

  return {
    files,
    edges,
    adjacency,
    unresolved: unresolved.sort(),
    boundaryViolations,
    cycles: stronglyConnectedComponents(files, adjacency).map((component) => component.map(relativePath))
  };
}

test("production source files stay below the 800-line limit", () => {
  const productionFiles = productionRoots.flatMap((root) => sourceFiles(path.join(repositoryRoot, root)));
  const oversized = productionFiles
    .map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n").length }))
    .filter(({ lines }) => lines > 800)
    .map(({ file, lines }) => `${relativePath(file)} (${lines} lines)`);
  expect(oversized, "production source files must remain under the 800-line limit").toEqual([]);
});

test("the versioned API dispatcher routes from the operation manifest", () => {
  const routeSource = readFileSync(path.join(repositoryRoot, "src/app/api/v1/[...path]/route.ts"), "utf8");
  expect(routeSource).toContain("const operation = matchApiOperation(method, path);");
  expect(routeSource).toContain("const operationId = operation.operationId;");
  expect(routeSource).not.toMatch(/path\[0\]/);
  expect(routeSource).not.toMatch(/method ===/);
});

test("the real production graph resolves imports and follows documented boundaries", () => {
  const graph = buildProductionGraph();
  expect(graph.unresolved, "local production imports must resolve through the configured TypeScript aliases").toEqual([]);
  expect(graph.boundaryViolations, "production modules must follow the explicit layer dependency allowlist").toEqual([]);
});

test("the real production graph is acyclic", () => {
  const graph = buildProductionGraph();
  const cycles = graph.cycles.map((cycle) => cycle.join(" -> ")).join("\n");
  expect(graph.cycles, `production import cycles detected:\n${cycles}`).toEqual([]);
});
