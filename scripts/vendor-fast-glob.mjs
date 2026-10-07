import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const url = "https://registry.npmjs.org/fast-glob/-/fast-glob-3.3.1.tgz";
const integrity = "sha512-kNFPyjhh5cKjrUltxs+wFx+ZkbRaxxmZ+X0ZU31SOsxCEtP9VPgtq2teZw1DebupL5GmDaNQ6yKMMVcM41iqDg==";
const bracesUrl = "https://registry.npmjs.org/braces/-/braces-3.0.3.tgz";
const bracesIntegrity = "sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const temporary = await mkdtemp(path.join(tmpdir(), "cvg-fast-glob-package-"));

async function hashes(directory, prefix = "") {
  const files = {};
  for (const entry of (await readdir(path.join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await hashes(directory, relative));
    else if (entry.isFile()) files[relative] = sha256(await readFile(path.join(directory, relative)));
    else throw new Error(`Unexpected package entry: ${relative}`);
  }
  return files;
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Upstream patch context changed: ${before}`);
  return source.replace(before, after);
}

async function normalizeModes(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await normalizeModes(filename);
    else await chmod(filename, 0o644);
  }
}

try {
  const upstreamPath = process.argv[2];
  const response = upstreamPath ? undefined : await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (response && !response.ok) throw new Error(`Upstream download returned ${response.status}`);
  const archive = upstreamPath ? await readFile(upstreamPath) : Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== integrity) {
    throw new Error("Upstream package integrity mismatch");
  }
  await writeFile(path.join(temporary, "upstream.tgz"), archive);
  execFileSync("tar", ["-xzf", path.join(temporary, "upstream.tgz"), "-C", temporary]);
  const directory = path.join(temporary, "package");
  const upstreamFiles = await hashes(directory);
  const packagePath = path.join(directory, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  if (manifest.name !== "fast-glob" || manifest.version !== "3.3.1") throw new Error("Unexpected upstream identity");
  manifest.version = "3.3.1-cvg.1";
  manifest.engines = { node: ">=22" };
  delete manifest.dependencies.micromatch;
  manifest.dependencies.picomatch = "4.0.7";
  manifest.dependencies["fill-range"] = "7.1.1";
  manifest.cvgPatch = {
    upstream: "fast-glob@3.3.1", integrity,
    purpose: "Replace micromatch/braces dependency with picomatch and a genuinely patched, bounded subset of the original brace parser/expander; preserve lexical semantics and filesystem traversal",
    source: "scripts/vendor-fast-glob.mjs, scripts/fast-glob-safe-pattern.cjs and scripts/fast-glob-brace-limits.cjs"
  };
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  const helper = await readFile(path.join(root, "scripts/fast-glob-safe-pattern.cjs"));
  await writeFile(path.join(directory, "out/utils/safe-pattern.cjs"), helper);
  const bracesResponse = await fetch(bracesUrl, { signal: AbortSignal.timeout(30_000) });
  if (!bracesResponse.ok) throw new Error(`Brace source download returned ${bracesResponse.status}`);
  const bracesArchive = Buffer.from(await bracesResponse.arrayBuffer());
  if (`sha512-${createHash("sha512").update(bracesArchive).digest("base64")}` !== bracesIntegrity) throw new Error("Brace source integrity mismatch");
  const bracesTemporary = path.join(temporary, "braces-source");
  await mkdir(bracesTemporary);
  await writeFile(path.join(bracesTemporary, "source.tgz"), bracesArchive);
  execFileSync("tar", ["-xzf", path.join(bracesTemporary, "source.tgz"), "-C", bracesTemporary]);
  const bracesDirectory = path.join(bracesTemporary, "package");
  const bracesFiles = await hashes(bracesDirectory);
  const boundedDirectory = path.join(directory, "out/utils/bounded-braces");
  await mkdir(boundedDirectory);
  const sources = {};
  for (const original of ["lib/parse.js", "lib/expand.js", "lib/stringify.js", "lib/utils.js", "lib/constants.js", "LICENSE"]) {
    const destination = path.basename(original);
    let source = await readFile(path.join(bracesDirectory, original), "utf8");
    if (destination === "parse.js") source = replaceOnce(source, "const parse = (input, options = {}) => {", "const parse = (input, options = {}) => {\n  require('../safe-pattern.cjs').assertSafePattern(input);");
    if (destination === "expand.js") {
      source = replaceOnce(source, "const append = (queue = '', stash = '', enclose = false) => {", "const append = (queue = '', stash = '', enclose = false, depth = 0) => {\n  if (depth > 64) throw new RangeError('Brace append exceeds structural limits');");
      source = replaceOnce(source, "append(value, stash, enclose)", "append(value, stash, enclose, depth + 1)");
      source = replaceOnce(source, "append(item, ele, enclose)", "append(item, ele, enclose, depth + 1)");
      source = replaceOnce(source, "  stash = [].concat(stash);", "  stash = [].concat(stash);\n  if (queue.length > 1000 || stash.length > 1000 || queue.length * stash.length > 1000) {\n    throw new RangeError('Brace expansion exceeds 1000 results');\n  }");
      source = replaceOnce(source, "const expand = (ast, options = {}) => {", "const expand = (ast, options = {}) => {\n  require('./limits.cjs').assertAst(ast);");
      source = replaceOnce(source, "utils.exceedsLimit(...args, options.step, rangeLimit)", "utils.exceedsLimit(args[0], args[1], args[2] || options.step || 1, rangeLimit)");
    }
    if (destination === "stringify.js") source = replaceOnce(source, "module.exports = (ast, options = {}) => {", "module.exports = (ast, options = {}) => {\n  require('./limits.cjs').assertAst(ast);");
    if (destination === "utils.js") {
      // Retain the lexical helpers, replace the unbounded recursive flattener
      // and the ascending-only range check with bounded implementations.
      const marker = "exports.flatten = (...args) => {";
      if (source.split(marker).length !== 2 || !source.trimEnd().endsWith("};")) throw new Error("Upstream flatten context changed");
      source = `${source.slice(0, source.indexOf(marker))}exports.flatten = require('./limits.cjs').flatten;\n`;
      source = replaceOnce(source, "exports.exceedsLimit = (min, max, step = 1, limit) => {\n  if (limit === false) return false;\n  if (!exports.isInteger(min) || !exports.isInteger(max)) return false;\n  return ((Number(max) - Number(min)) / Number(step)) >= limit;\n};", "exports.exceedsLimit = require('./limits.cjs').exceedsRangeLimit;");
    }
    await writeFile(path.join(boundedDirectory, destination), source);
    sources[`out/utils/bounded-braces/${destination}`] = { source: original, originalSha256: bracesFiles[original], patchedSha256: sha256(source) };
  }
  await writeFile(path.join(boundedDirectory, "limits.cjs"), await readFile(path.join(root, "scripts/fast-glob-brace-limits.cjs")));
  const patternPath = path.join(directory, "out/utils/pattern.js");
  let pattern = await readFile(patternPath, "utf8");
  pattern = replaceOnce(pattern, 'const micromatch = require("micromatch");', 'const safePattern = require("./safe-pattern.cjs");');
  pattern = replaceOnce(pattern, 'micromatch.braces(pattern, { expand: true, nodupes: true })', "safePattern.expandBraces(pattern)");
  pattern = replaceOnce(pattern, "micromatch.scan(pattern,", "safePattern.scan(pattern,");
  pattern = replaceOnce(pattern, "micromatch.makeRe(pattern, options)", "safePattern.makeRe(pattern, options)");
  await writeFile(patternPath, pattern);
  const indexPath = path.join(directory, "out/index.js");
  let index = await readFile(indexPath, "utf8");
  index = replaceOnce(index, 'const utils = require("./utils");', 'const utils = require("./utils");\nconst { assertSafePattern } = require("./utils/safe-pattern.cjs");');
  index = replaceOnce(index, "    const isValidSource = source.every", "    source.forEach(assertSafePattern);\n    const isValidSource = source.every");
  await writeFile(indexPath, index);
  const patchedFiles = await hashes(directory);
  const output = path.join(root, "vendor/fast-glob-3.3.1-cvg.1.tgz");
  await mkdir(path.dirname(output), { recursive: true });
  await normalizeModes(directory);
  execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", output, "-C", temporary, "package"]);
  const provenance = {
    upstream: { name: "fast-glob", version: "3.3.1", url, integrity, files: upstreamFiles },
    patch: { version: manifest.version, files: patchedFiles, modified: ["package.json", "out/index.js", "out/utils/pattern.js"], added: ["out/utils/safe-pattern.cjs", ...Object.keys(sources), "out/utils/bounded-braces/limits.cjs"].sort() },
    boundedBraces: { upstream: { url: bracesUrl, integrity: bracesIntegrity, files: bracesFiles }, sources },
    archive: { path: "vendor/fast-glob-3.3.1-cvg.1.tgz", sha256: sha256(await readFile(output)) }
  };
  await writeFile(path.join(root, "vendor/fast-glob.provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Generated ${provenance.archive.path}: ${provenance.archive.sha256}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
