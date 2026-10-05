import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const oraclePath = fileURLToPath(new URL('./fixtures/eslint-glob-parity.json', import.meta.url));
const require = createRequire(import.meta.url);
// Resolve through Next's dependency boundary, including nested npm overrides.
const captureOriginal = process.argv.includes('--capture-original');
const originalPackage = process.env.CVG_ORIGINAL_NEXT_PACKAGE;
if (originalPackage) {
  assert(captureOriginal, 'An isolated original package is permitted only for explicit oracle capture');
  assert(path.isAbsolute(originalPackage), 'CVG_ORIGINAL_NEXT_PACKAGE must be an absolute package.json path');
}
const nextRequire = createRequire(originalPackage ?? require.resolve('@next/eslint-plugin-next/package.json'));
const fg = nextRequire('fast-glob');
const fgPackage = nextRequire('fast-glob/package.json');
const nextPackage = nextRequire('./package.json');
const { getRootDirs } = nextRequire('./dist/utils/get-root-dirs.js');
const nextPlugin = nextRequire('./dist/index.js');
const { Linter } = require('eslint');
const ruleName = '@next/next/no-html-link-for-pages';
// Independently hashed from the integrity-verified original braces 3.0.3
// archive used by the original oracle, before the bounded source backport.
const originalBracesFiles = {
  'lib/parse.js': 'e572166565f15fa6ad9865ae49d678218e32aabfd1b3720f6d0d43d39800d310',
  'lib/constants.js': 'c18ac5adb57308f1ce42a28552da3a31f5d83709743ebd9a636336813a744d4b',
  'lib/utils.js': 'b5a7596aa67730412b3c029ef09e84e6b67b8e445cffd35d1d295549c89066c7',
  'lib/stringify.js': '379f22d77bfa1478341ccd49c5e4267464aabcbba03558bab332aac23fc6f23a',
  'lib/expand.js': '41ccc196ebfa7b7781a634e721eb744e4e7bcb54cba427a7e3d6806a1b9e58f7',
  LICENSE: '35bdd8a44339719441900fb50fbefc5e2dca1ca662cbaed7a687de842c8b70f2',
};

// Keep grammar fixtures outside the original apps tree so existing wildcard,
// recursive and API observations remain byte-for-byte comparable.
const grammarCwd = 'grammar/apps/quoted roots';
const grammarDirectories = [
  ['alpha', 'grammar-alpha'], ['beta', 'grammar-beta'],
  ['a', 'grammar-a'], ['b', 'grammar-b'], [',', 'grammar-comma'],
  ['{', 'grammar-open-brace'], ['}', 'grammar-close-brace'],
  ['[a]', 'grammar-square-a'], ['a*', 'grammar-star'], ['aa', 'grammar-aa'],
  ['a\\*', 'grammar-backslash-star'], ['back\\slash', 'grammar-backslash'],
  ['{a,b}', 'grammar-literal-braces'], ['{alpha,beta}', 'grammar-literal-alternatives'],
  ['"{a,b}"', 'grammar-quoted-braces'], ['"alpha"', 'grammar-quoted-alpha'],
  ['01', 'grammar-one'], ['02', 'grammar-two'], ['03', 'grammar-three'],
  ['1', 'grammar-number-one'], ['2', 'grammar-number-two'], ['3', 'grammar-number-three'],
];

const specification = {
  directories: ['apps/alpha', 'apps/beta', 'apps/gamma', 'apps/.hidden', 'apps/01', 'apps/02', 'apps/03', 'apps/05', 'apps/literal{one}', 'apps/literal(paren)', 'apps/deep/inner', 'elsewhere', 'context-root', 'cycle',
    ...grammarDirectories.map(([name]) => `${grammarCwd}/${name}`)],
  files: [
    'apps/file.txt', 'apps/alpha/pages/index.tsx', 'apps/alpha/pages/alpha.tsx',
    'apps/alpha/pages/blog/[slug].tsx', 'apps/alpha/pages/docs/index.jsx',
    'apps/beta/src/pages/beta.jsx', 'apps/gamma/app/page.tsx',
    'apps/gamma/app/gamma/page.tsx', 'apps/gamma/app/(group)/grouped/page.tsx',
    'apps/gamma/app/@slot/slot/page.tsx', 'apps/gamma/app/layout.tsx',
    'apps/.hidden/pages/hidden.tsx', 'apps/01/pages/one.tsx',
    'apps/02/pages/two.tsx', 'apps/03/pages/three.tsx', 'apps/05/pages/five.tsx',
    'elsewhere/pages/outside.tsx', 'context-root/pages/context.tsx',
    ...grammarDirectories.map(([name, route]) => `${grammarCwd}/${name}/pages/${route}.tsx`),
  ],
  symlinks: [['links/alpha', '../apps/alpha'], ['apps/alias', 'alpha'], ['cycle/loop', '.']],
};

const rootCases = [
  { id: 'literal', rootDir: 'apps/alpha' },
  { id: 'trailing-slash', rootDir: 'apps/alpha/' },
  { id: 'dot-prefix', rootDir: './apps/alpha' },
  { id: 'wildcard-excludes-dot', rootDir: 'apps/*' },
  { id: 'explicit-dot', rootDir: 'apps/.*' },
  { id: 'brace-alternatives', rootDir: 'apps/{alpha,beta}' },
  { id: 'brace-nested', rootDir: 'apps/{alpha,{beta,gamma}}' },
  { id: 'brace-padded-range', rootDir: 'apps/{01..03}' },
  { id: 'brace-step-range', rootDir: 'apps/{01..05..2}' },
  { id: 'brace-descending-step', rootDir: 'apps/{05..01..2}' },
  { id: 'brace-duplicates', rootDir: 'apps/{alpha,alpha,beta}' },
  { id: 'brace-empty-alternative', rootDir: 'apps/{alpha,}' },
  { id: 'brace-literal', rootDir: 'apps/literal{one}' },
  { id: 'extglob-at', rootDir: 'apps/@(alpha|beta)' },
  { id: 'extglob-plus', rootDir: 'apps/+(alpha|beta)' },
  { id: 'extglob-question', rootDir: 'apps/?(alpha|beta)' },
  { id: 'extglob-star', rootDir: 'apps/*(alpha|beta)' },
  { id: 'extglob-negative-dot-quirk', rootDir: 'apps/!(alpha|beta)' },
  { id: 'standalone-negation', rootDir: '!apps/alpha' },
  { id: 'standalone-bang', rootDir: '!' },
  { id: 'array-independent-negations', rootDir: ['apps/*', '!apps/alpha'] },
  { id: 'array-retains-duplicates', rootDir: ['apps/alpha', 'apps/alpha', 'apps/{alpha,beta}'] },
  { id: 'array-ignores-nonstrings', rootDir: [null, 7, false, {}, ['apps/beta'], 'apps/alpha'] },
  { id: 'empty-array', rootDir: [] },
  { id: 'nonstrings-use-context', rootDir: 7 },
  { id: 'empty-string-error', rootDir: '' },
  { id: 'array-empty-string-error', rootDir: ['apps/alpha', ''] },
  { id: 'absolute', rootDir: '$FIXTURE/apps/alpha' },
  { id: 'absolute-wildcard', rootDir: '$FIXTURE/apps/@(alpha|beta)' },
  { id: 'backslash-normalized-on-linux', rootDir: 'apps\\alpha' },
  { id: 'backslash-glob-normalized-on-linux', rootDir: 'apps\\{alpha,beta}' },
  { id: 'missing-directory', rootDir: 'apps/missing' },
  { id: 'file-excluded', rootDir: 'apps/file.txt' },
  { id: 'parent-path', rootDir: '../apps/alpha', processCwd: 'context-root' },
  { id: 'dot-parent-path', rootDir: './../apps/{alpha,beta}', processCwd: 'context-root' },
  { id: 'recursive-directories', rootDir: 'apps/**' },
  { id: 'recursive-pages', rootDir: 'apps/**/pages' },
  { id: 'directory-symlink', rootDir: 'links/*' },
  { id: 'default-context-cwd', contextCwd: 'context-root' },
  { id: 'explicit-uses-process-cwd', rootDir: 'apps/alpha', contextCwd: 'context-root' },
  { id: 'explicit-process-cwd-differs', rootDir: 'apps/alpha', processCwd: 'context-root', contextCwd: '.' },
  { id: 'app-only-real-rule-behavior', rootDir: 'apps/gamma' },
  { id: 'grammar-quoted-alternatives', rootDir: '"{alpha,beta}"', processCwd: grammarCwd },
  { id: 'grammar-quoted-short-alternatives', rootDir: '"{a,b}"', processCwd: grammarCwd },
  { id: 'grammar-single-quoted-alternatives', rootDir: "'{a,b}'", processCwd: grammarCwd },
  { id: 'grammar-quoted-padded-range', rootDir: '"{01..03}"', processCwd: grammarCwd },
  { id: 'grammar-quoted-step-range', rootDir: '"{01..03..2}"', processCwd: grammarCwd },
  { id: 'grammar-bracket-with-braces', rootDir: '[{a,b}]', processCwd: grammarCwd },
  { id: 'grammar-bracket-literal-square', rootDir: '[a]', processCwd: grammarCwd },
  { id: 'grammar-escaped-braces-normalized', rootDir: '\\{a,b\\}', processCwd: grammarCwd },
  { id: 'grammar-escaped-star-normalized', rootDir: '{a\\*,b}', processCwd: grammarCwd },
  { id: 'grammar-backslash-name-normalized', rootDir: 'back\\slash', processCwd: grammarCwd },
  { id: 'grammar-array-independent-quotes-class', rootDir: ['"{a,b}"', '[{a,b}]'], processCwd: grammarCwd },
  { id: 'grammar-small-scientific-numeric', rootDir: '{1e0..3e0}', processCwd: grammarCwd },
  { id: 'grammar-small-whitespace-numeric', rootDir: '{ 1 .. 3 }', processCwd: grammarCwd },
  { id: 'grammar-small-descending-scientific', rootDir: '{3e0..1e0}', processCwd: grammarCwd },
  { id: 'grammar-small-stepped-scientific', rootDir: '{1e0..3e0..2e0}', processCwd: grammarCwd },
  { id: 'grammar-small-mixed-numeric-char', rootDir: '{1e0..b..49}', processCwd: grammarCwd },
  { id: 'grammar-small-alpha-range', rootDir: '{a..b}', processCwd: grammarCwd },
];

const anchors = [
  ['home', '<a href="/">home</a>'],
  ['alpha', '<a href="/alpha">alpha</a>'],
  ['beta', '<a href="/beta">beta</a>'],
  ['blog', '<a href="/blog/pet">blog</a>'],
  ['docs-query', '<a href="/docs?lang=pt#top">docs</a>'],
  ['hidden', '<a href="/hidden">hidden</a>'],
  ['one', '<a href="/one">one</a>'],
  ['two', '<a href="/two">two</a>'],
  ['three', '<a href="/three">three</a>'],
  ['five', '<a href="/five">five</a>'],
  ['app-page', '<a href="/gamma">gamma</a>'],
  ['app-group', '<a href="/grouped">group</a>'],
  ['app-parallel', '<a href="/slot">slot</a>'],
  ['context', '<a href="/context">context</a>'],
  ['outside', '<a href="/outside">outside</a>'],
  ['missing-route', '<a href="/does-not-exist">missing</a>'],
  ['external', '<a href="https://example.com/alpha">external</a>'],
  ['protocol-relative', '<a href="//example.com/alpha">external</a>'],
  ['blank-target', '<a href="/alpha" target="_blank">blank</a>'],
  ['download', '<a href="/alpha" download>download</a>'],
  ['expression', '<a href={"/alpha"}>expression</a>'],
  ['link-component', '<Link href="/alpha">link</Link>'],
  ['no-href', '<a>anchor</a>'],
  ...grammarDirectories.map(([, route]) => [route, `<a href="/${route}">${route}</a>`]),
];

const apiCases = [
  { id: 'directories', patterns: 'apps/*', options: { onlyDirectories: true } },
  { id: 'braces', patterns: 'apps/{alpha,{beta,gamma}}', options: { onlyDirectories: true } },
  { id: 'negative-extglob', patterns: 'apps/!(alpha|beta)', options: { onlyDirectories: true } },
  { id: 'dot-enabled', patterns: 'apps/*', options: { onlyDirectories: true, dot: true } },
  { id: 'files-recursive', patterns: 'apps/**/*.{tsx,jsx}', options: {} },
  { id: 'negation-array', patterns: ['apps/*', '!apps/alpha'], options: { onlyDirectories: true } },
  { id: 'ignore', patterns: 'apps/*', options: { onlyDirectories: true, ignore: ['apps/beta'] } },
  { id: 'no-follow-symlinks', patterns: 'links/*', options: { onlyDirectories: true, followSymbolicLinks: false } },
  { id: 'absolute-results', patterns: 'apps/{alpha,beta}', options: { onlyDirectories: true, absolute: true } },
  { id: 'object-mode', patterns: 'apps/{alpha,beta}', options: { onlyDirectories: true, objectMode: true } },
  { id: 'stats', patterns: 'apps/{alpha,beta}', options: { onlyDirectories: true, stats: true } },
  { id: 'case-insensitive', patterns: 'apps/ALPHA', options: { onlyDirectories: true, caseSensitiveMatch: false } },
  { id: 'grammar-quoted-alternatives', patterns: '"{alpha,beta}"', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-quoted-short-alternatives', patterns: '"{a,b}"', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-single-quoted-alternatives', patterns: "'{a,b}'", processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-quoted-padded-range', patterns: '"{01..03}"', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-quoted-step-range', patterns: '"{01..03..2}"', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-bracket-with-braces', patterns: '[{a,b}]', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-bracket-literal-square', patterns: '[a]', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-escaped-braces', patterns: '\\{a,b\\}', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-escaped-star-alternative', patterns: '{a\\*,b}', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-escaped-comma', patterns: '{a\\,b}', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-escaped-backslash-name', patterns: 'back\\\\slash', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-escaped-backslash-star', patterns: 'a\\\\\\*', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-escaped-square-brackets', patterns: '\\[a\\]', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-mixed-quoted-class-array', patterns: ['"{a,b}"', '[{a,b}]'], processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-small-scientific-numeric', patterns: '{1e0..3e0}', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-small-whitespace-numeric', patterns: '{ 1 .. 3 }', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-small-descending-scientific', patterns: '{3e0..1e0}', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-small-stepped-scientific', patterns: '{1e0..3e0..2e0}', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-small-mixed-numeric-char', patterns: '{1e0..b..49}', processCwd: grammarCwd, options: { onlyDirectories: true } },
  { id: 'grammar-small-alpha-range', patterns: '{a..b}', processCwd: grammarCwd, options: { onlyDirectories: true } },
];

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'eslint-glob-parity-'));
  for (const entry of specification.directories) mkdirSync(path.join(dir, entry), { recursive: true });
  for (const entry of specification.files) {
    mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
    writeFileSync(path.join(dir, entry), 'export default function Page() { return null; }\n');
  }
  for (const [entry, target] of specification.symlinks) {
    mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
    symlinkSync(target, path.join(dir, entry), 'dir');
  }
  return dir;
}

function substitute(value, dir) {
  if (typeof value === 'string') return value.replaceAll('$FIXTURE', dir);
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, dir));
  return value;
}

function normalize(value, dir) {
  if (typeof value === 'string') return value.replaceAll(dir, '$FIXTURE');
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, dir));
  return value;
}

function failure(error, dir) {
  return { error: { name: error.name, ...(error.code ? { code: error.code } : {}), message: normalize(error.message, dir) } };
}

function inCwd(dir, run) {
  const previous = process.cwd();
  process.chdir(dir);
  try { return run(); } finally { process.chdir(previous); }
}

function contextFor(entry, dir) {
  return { cwd: path.resolve(dir, entry.contextCwd ?? '.'), settings: {
    next: Object.hasOwn(entry, 'rootDir') ? { rootDir: substitute(entry.rootDir, dir) } : {},
  } };
}

function rootsFor(entry, dir) {
  return inCwd(path.resolve(dir, entry.processCwd ?? '.'), () => {
    try { return { roots: normalize(getRootDirs(contextFor(entry, dir)).sort(), dir) }; }
    catch (error) { return failure(error, dir); }
  });
}

function lintFor(entry, dir) {
  return inCwd(path.resolve(dir, entry.processCwd ?? '.'), () => {
    const context = contextFor(entry, dir);
    const linter = new Linter({ cwd: context.cwd });
    const code = ['const links = <>', ...anchors.map(([, jsx]) => `  ${jsx}`), '</>;'].join('\n');
    // A no-root fixture intentionally exercises Next's once-only warning; isolate it
    // from test output without replacing the actual rule or its findings.
    const warnings = [];
    const previousWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const messages = linter.verify(code, {
        files: ['**/*.jsx'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { '@next/next': nextPlugin }, settings: context.settings,
        rules: { [ruleName]: 'error' },
      }, { filename: path.join(context.cwd, 'fixture.jsx') });
      return { findings: messages.map(({ ruleId, severity, message, line, column, endLine, endColumn, nodeType, fatal }) => ({
        ruleId, severity, message: normalize(message, dir), line, column,
        ...(endLine === undefined ? {} : { endLine }),
        ...(endColumn === undefined ? {} : { endColumn }), nodeType, ...(fatal ? { fatal } : {}),
      })) };
    } catch (error) { return failure(error, dir); }
    finally { console.warn = previousWarn; }
  });
}

function entriesFor(entries, dir) {
  return entries.map((entry) => typeof entry === 'string' ? normalize(entry, dir) : {
    path: normalize(entry.path, dir), name: entry.name,
    isDirectory: entry.dirent.isDirectory(), isFile: entry.dirent.isFile(),
    isSymbolicLink: entry.dirent.isSymbolicLink(),
    ...(entry.stats ? { statIsDirectory: entry.stats.isDirectory(), statIsFile: entry.stats.isFile() } : {}),
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function hash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

// Every potentially expensive probe runs out of process. A timeout, signal,
// missing report, silent [] result or wrong exception class fails the test.
const probeSource = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const nextRequire = createRequire(input.pluginPackage);
const fg = nextRequire('fast-glob');
const { getRootDirs } = nextRequire('./dist/utils/get-root-dirs.js');
const globOptions = { cwd: input.cwd, onlyDirectories: true,
  ...(input.mode === 'cycle-bounded' ? { deep: 3 } : {}) };
async function stream(pattern) {
  const results = [];
  for await (const item of fg.stream(pattern, globOptions)) results.push(item);
  return results;
}
const globMethods = {
  sync: (pattern) => fg.sync(pattern, globOptions),
  async: (pattern) => fg(pattern, globOptions),
  stream,
  generateTasks: (pattern) => fg.generateTasks(pattern, { onlyDirectories: true }),
  roots: (pattern) => getRootDirs({ cwd: input.cwd, settings: { next: { rootDir: pattern } } }),
};
async function main() {
  process.chdir(input.cwd);
  if (input.mode === 'cycle' || input.mode === 'cycle-bounded') {
    const results = {};
    const names = input.mode === 'cycle-bounded' ? ['sync', 'async', 'stream'] : ['sync', 'async', 'stream', 'roots'];
    for (const name of names) {
      try { results[name] = { roots: (await globMethods[name]('cycle/**')).sort() }; }
      catch (error) {
        if (input.mode === 'cycle-bounded') throw error;
        assert.equal(error.code, 'ELOOP', name + ': preserve original cycle failure');
        results[name] = { error: { name: error.name, code: error.code } };
      }
    }
    return results;
  }
  // Never feed hostile patterns to the old unsafe parser, even on an accidental
  // baseline run. Restoring upstream fails this guard, rather than running it.
  assert.equal(nextRequire('fast-glob/package.json').version, '3.3.1-cvg.1');
  if (input.mode === 'private-ast') {
    const base = 'fast-glob/out/utils/bounded-braces/';
    const expand = nextRequire(base + 'expand.js');
    const stringify = nextRequire(base + 'stringify.js');
    const parse = nextRequire(base + 'parse.js');
    const limits = nextRequire(base + 'limits.cjs');
    let astChecks = 0;
    let flattenChecks = 0;
    let rangeChecks = 0;
    const reject = (run, id) => assert.throws(run, (error) => {
      assert(error instanceof RangeError, id + ': must explicitly throw RangeError');
      assert.doesNotMatch(error.message, /call stack|stack overflow/i, id + ': native stack overflow is not controlled rejection');
      return true;
    }, id);
    const astCases = [
      ['self-child-cycle', () => { const root = { type: 'root', nodes: [] }; root.nodes.push(root); return root; }],
      ['self-parent-cycle', () => { const root = { type: 'root', nodes: [] }; root.parent = root; return root; }],
      ['two-node-parent-cycle', () => { const root = { type: 'root', nodes: [] }; const other = { nodes: [] }; root.parent = other; other.parent = root; return root; }],
      ['shared-child-node', () => { const child = { type: 'text', value: 'a' }; return { type: 'root', nodes: [child, child] }; }],
      ['node-budget-exceeded', () => ({ type: 'root', nodes: Array.from({ length: 10000 }, () => ({ type: 'text', value: 'a' })) })],
      ['invalid-children', () => ({ type: 'root', nodes: {} })],
      ['ast-text-budget', () => ({ type: 'root', nodes: [{ type: 'text', value: 'a'.repeat(8193) }] })],
      ['ast-invalid-text', () => ({ type: 'root', nodes: [{ type: 'text', value: 7 }] })],
      ['own-queue-cycle', () => { const queue = []; queue.push(queue); return { type: 'root', nodes: [], queue }; }],
      ['foreign-parent-queue-cycle', () => {
        const queue = []; queue.push(queue);
        const foreign = { type: 'root', queue };
        return { type: 'root', nodes: [{ type: 'paren', parent: foreign, nodes: [{ type: 'text', value: 'a' }] }] };
      }],
      ['escaped-ast-foreign-parent-queue-cycle', () => {
        const ast = parse('\\{a,b\\}');
        const queue = []; queue.push(queue);
        const text = ast.nodes.find((node) => node.type === 'text');
        assert(text, 'escaped input must retain a text node');
        text.parent = { type: 'root', queue };
        return ast;
      }],
      ['own-queue-text-budget', () => ({ type: 'root', nodes: [], queue: ['a'.repeat(8193)] })],
      ['foreign-parent-queue-text-budget', () => ({ type: 'root', nodes: [], parent: { type: 'root', queue: ['a'.repeat(8193)] } })],
      ['queue-nonstring-leaf', () => ({ type: 'root', nodes: [], queue: [7] })],
      ['aggregate-queue-leaf-budget', () => ({ type: 'root', nodes: Array.from({ length: 11 }, () => ({ type: 'text', value: 'a', queue: Array(1000).fill('a') })) })],
      ['foreign-parent-deep-queue', () => {
        let queue = 'a';
        for (let depth = 0; depth < 100; depth += 1) queue = [queue];
        return { type: 'root', nodes: [], parent: { type: 'root', queue } };
      }],
      ['foreign-parent-queue-result-budget', () => ({ type: 'root', nodes: [], parent: { type: 'root', queue: Array(1001).fill('a') } })],
    ];
    for (const depth of [100, 101, 1000, 4000]) {
      astCases.push(['ast-depth-' + depth, () => {
        const root = { type: 'root', nodes: [] };
        let tail = root;
        for (let index = 0; index < depth; index += 1) {
          const child = { type: 'brace', nodes: [], parent: tail };
          tail.nodes.push(child); tail = child;
        }
        return root;
      }]);
      astCases.push(['parent-depth-' + depth, () => {
        const root = { type: 'root', nodes: [] };
        let tail = root;
        for (let index = 0; index < depth; index += 1) { tail.parent = {}; tail = tail.parent; }
        return root;
      }]);
    }
    for (const [id, create] of astCases) {
      for (const method of [limits.assertAst, stringify, expand]) {
        reject(() => method(create()), id);
        astChecks += 1;
      }
    }
    const flattenCases = [
      ['flatten-cycle', () => { const values = []; values.push(values); return values; }],
      ['flatten-result-budget', () => Array(1001).fill('a')],
      ['flatten-aggregate-result-budget', () => [Array(501).fill('a'), Array(501).fill('b')]],
      ['flatten-visit-budget', () => Array.from({ length: 11 }, () => Array.from({ length: 1000 }, () => []))],
      ['flatten-pending-stack-budget', () => {
        let values = [];
        for (let depth = 0; depth < 11; depth += 1) values = [...Array.from({ length: 999 }, () => []), values];
        return values;
      }],
    ];
    for (const depth of [100, 101, 1000, 4000]) {
      flattenCases.push(['flatten-depth-' + depth, () => {
        let values = 'a';
        for (let index = 0; index < depth; index += 1) values = [values];
        return values;
      }]);
    }
    for (const [id, create] of flattenCases) {
      reject(() => limits.flatten(create()), id); flattenChecks += 1;
    }
    const ranges = input.cases.filter((item) => item.expansion && item.pattern.includes('..')).map((item) => item.pattern);
    for (const pattern of ranges) {
      for (const options of [{}, { rangeLimit: false }, { rangeLimit: 1000000000 }, { rangeLimit: NaN }, { step: NaN }, { step: NaN, rangeLimit: NaN }]) {
        reject(() => expand(parse(pattern), options), 'private range ' + pattern); rangeChecks += 1;
      }
    }
    const optionCases = [
      ['custom-range-limit-with-explicit-step', '{1..1001..100}', { rangeLimit: 10 }],
      ['explicit-step-overrides-option-step', '{1..2001..2}', { step: 1000, rangeLimit: NaN }],
      ['descending-explicit-step-overrides-option-step', '{2001..1..2}', { step: 1000, rangeLimit: 10000 }],
      ['option-step-with-NaN-range-limit', '{1..2001}', { step: 2, rangeLimit: NaN }],
    ];
    for (const [id, pattern, options] of optionCases) {
      reject(() => expand(parse(pattern), options), id);
    }
    reject(() => expand(parse('{a,b}'.repeat(10))), 'private combination product');
    reject(() => expand(parse('{a,a}'.repeat(10))), 'private duplicate combination product');
    for (const item of input.cases.filter((item) => !item.expansion)) {
      reject(() => parse(item.pattern), 'private parser ' + item.id);
    }
    assert.deepEqual(limits.flatten(Array(1000).fill('a')), Array(1000).fill('a'));
    assert.equal(limits.exceedsRangeLimit('1000', '1'), false);
    assert.equal(limits.exceedsRangeLimit('1001', '1'), true);
    assert.equal(limits.exceedsRangeLimit('a', '\uffff'), true);
    assert.equal(limits.exceedsRangeLimit('\uffff', 'a'), true);
    assert.equal(limits.exceedsRangeLimit('1', '1e9', NaN, NaN), true);
    assert.equal(limits.exceedsRangeLimit('1e9', '1', NaN, NaN), true);
    assert.deepEqual(expand(parse('{1..3}'), { step: NaN, rangeLimit: NaN }), ['1', '2', '3']);
    assert.equal(expand(parse('{1..2001}'), { step: 4 }).length, 501);
    assert.equal(expand(parse('{1..1001..100}'), { step: 1, rangeLimit: 11 }).length, 11);
    assert.equal(expand(parse('{1000..1}')).length, 1000);
    assert.equal(stringify(parse('plain')), 'plain');
    return { astChecks, flattenChecks, rangeChecks, optionChecks: optionCases.length, productChecks: 2, parserChecks: input.cases.filter((item) => !item.expansion).length };
  }
  const helper = nextRequire('fast-glob/out/utils/safe-pattern.cjs');
  const methods = { ...helper, ...globMethods };
  let checks = 0;
  for (const item of input.cases) {
    const selected = item.expansion
      ? ['expandBraces', ...Object.keys(globMethods)]
      : Object.keys(methods);
    for (const name of selected) {
      let caught;
      try { await methods[name](item.pattern); } catch (error) { caught = error; }
      assert(caught instanceof RangeError, item.id + '/' + name + ': must explicitly throw RangeError, got ' + (caught ? caught.name : 'success'));
      assert.doesNotMatch(caught.message, /call stack|stack overflow/i, item.id + '/' + name + ': native stack overflow is not controlled rejection');
      checks += 1;
    }
  }
  return { cases: input.cases.length, checks };
}
main().then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; });
`;

function runProbe(mode, dir, cases = []) {
  if (mode !== 'cycle' && mode !== 'cycle-bounded') {
    assert.equal(fgPackage.version, '3.3.1-cvg.1', 'Never run hostile probes against the original');
    assert.equal(hash(nextRequire.resolve('fast-glob/out/utils/bounded-braces/limits.cjs')), hash(path.join(projectDir, 'scripts/fast-glob-brace-limits.cjs')), 'Install the current range/AST guards before running hostile probes');
  }
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=commonjs', '-e', probeSource], {
    input: JSON.stringify({ mode, cwd: dir, cases, pluginPackage: nextRequire.resolve('./package.json') }),
    cwd: projectDir, encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024,
  });
  assert.equal(result.error, undefined, `${mode}: child exceeded bounds: ${result.error?.message}`);
  assert.equal(result.signal, null, `${mode}: child terminated with ${result.signal}`);
  assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
  assert.equal(result.stderr, '', `${mode}: unexpected child diagnostics`);
  assert(result.stdout.length > 0, `${mode}: missing child report`);
  return JSON.parse(result.stdout);
}

function hostileCases() {
  const cases = [];
  for (const depth of [100, 101, 1000, 4000]) {
    cases.push(
      { id: `braces-balanced-${depth}`, pattern: '{'.repeat(depth) + 'a' + '}'.repeat(depth) },
      { id: `braces-unclosed-${depth}`, pattern: '{'.repeat(depth) + 'a' },
      { id: `extglob-balanced-${depth}`, pattern: '@('.repeat(depth) + 'a' + ')'.repeat(depth) },
      { id: `extglob-unclosed-${depth}`, pattern: '@('.repeat(depth) + 'a' },
    );
  }
  cases.push(
    { id: 'depth-first-rejected-brace', pattern: '{'.repeat(33) + 'a' + '}'.repeat(33) },
    { id: 'depth-first-rejected-extglob', pattern: '@('.repeat(33) + 'a' + ')'.repeat(33) },
    { id: 'mixed-group-depth', pattern: '{@('.repeat(17) + 'a' + ')}'.repeat(17) },
    { id: 'brace-group-count', pattern: '{a}'.repeat(65) },
    { id: 'extglob-group-count', pattern: '@(a)'.repeat(65) },
    { id: 'length-first-rejected', pattern: 'a'.repeat(4097) },
    { id: 'negative-length-first-rejected', pattern: '!' + 'a'.repeat(4096) },
    { id: 'expansion-first-rejected', pattern: '{1..1001}', expansion: true },
    { id: 'expansion-padded-rejected', pattern: '{0001..1001}', expansion: true },
    { id: 'chained-alternatives', pattern: '{a,b}'.repeat(10), expansion: true },
    { id: 'chained-duplicate-alternatives', pattern: '{a,a}'.repeat(10), expansion: true },
    { id: 'descending-expansion-first-rejected', pattern: '{1001..1}', expansion: true },
    { id: 'descending-huge-range', pattern: '{1000000000..1}', expansion: true },
    { id: 'descending-stepped-range', pattern: '{1001..1..-1}', expansion: true },
    { id: 'zero-step-range', pattern: '{1..1001..0}', expansion: true },
    { id: 'alpha-huge-range', pattern: '{a..\uffff}', expansion: true },
    { id: 'alpha-descending-huge-range', pattern: '{\uffff..a}', expansion: true },
    { id: 'unsafe-integer-range', pattern: '{9007199254740993..9007199254740994}', expansion: true },
    { id: 'scientific-descending-range', pattern: '{1e9..1}', expansion: true },
    { id: 'scientific-ascending-range', pattern: '{1..1e9}', expansion: true },
    { id: 'whitespace-scientific-range', pattern: '{ 1 ..1e9}', expansion: true },
    { id: 'whitespace-descending-range', pattern: '{ 1e9 .. 1 }', expansion: true },
    { id: 'negative-scientific-range', pattern: '{-1e9..1}', expansion: true },
    { id: 'mixed-numeric-unicode-range', pattern: '{1e9..\uffff}', expansion: true },
    { id: 'mixed-unicode-numeric-range', pattern: '{\uffff..1e9}', expansion: true },
    { id: 'stepped-expansion-first-rejected', pattern: '{1..2001..2}', expansion: true },
    { id: 'descending-stepped-expansion-first-rejected', pattern: '{2001..1..2}', expansion: true },
    { id: 'scientific-step-range', pattern: '{1..1e9..1e3}', expansion: true },
  );
  return cases;
}

async function collectOriginal() {
  assert.equal(nextPackage.version, '16.3.0');
  assert.equal(fgPackage.version, '3.3.1');
  assert.equal(process.version, 'v22.23.2');
  assert.equal(process.platform, 'linux');
  const rulesDir = path.join(path.dirname(nextRequire.resolve('./package.json')), 'dist/rules');
  const ruleHashes = Object.fromEntries(readdirSync(rulesDir).filter((file) => file.endsWith('.js')).sort().map((file) => [file, hash(path.join(rulesDir, file))]));
  assert.equal(Object.keys(ruleHashes).length, 22);
  const dir = fixture();
  try {
    const roots = rootCases.map((entry) => ({ ...entry, expected: rootsFor(entry, dir), lint: lintFor(entry, dir) }));
    const apis = [];
    for (const entry of apiCases) {
      const options = { ...entry.options, cwd: path.resolve(dir, entry.processCwd ?? '.') };
      const expected = entriesFor(fg.sync(entry.patterns, options), dir);
      assert.deepEqual(entriesFor(await fg(entry.patterns, options), dir), expected);
      const streamEntries = [];
      for await (const item of fg.stream(entry.patterns, options)) streamEntries.push(item);
      assert.deepEqual(entriesFor(streamEntries, dir), expected);
      apis.push({ ...entry, expected });
    }
    validateLintOracle(roots);
    return {
      schemaVersion: 1,
      oracle: { nextPlugin: nextPackage.version, fastGlob: fgPackage.version, node: process.version, platform: process.platform,
        capturedAt: new Date().toISOString(), rootUtilitySha256: hash(nextRequire.resolve('./dist/utils/get-root-dirs.js')),
        fastGlobIndexSha256: hash(nextRequire.resolve('fast-glob')), ruleHashes,
        note: 'Original-package observations: initial root/API cases were recorded before the fork; Linter and grammar extensions were explicitly captured from the isolated unpatched original. Sorted lists preserve duplicate counts. Backslash root fixtures test Next normalization on Linux only; raw API fixtures exercise POSIX escape semantics. No hostile input was executed against the original.' },
      filesystem: specification, anchors, roots, apis,
      symlinkCycle: runProbe('cycle', dir),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function validateLintOracle(roots) {
  const named = Object.fromEntries(roots.map((entry) => [entry.id, entry]));
  const findingAnchors = (id) => named[id].lint.findings.map((finding) => anchors[finding.line - 2][0]);
  for (const entry of roots) {
    if (entry.expected.error) {
      assert.equal(entry.lint.error?.name, entry.expected.error.name, entry.id);
      continue;
    }
    assert(Array.isArray(entry.lint.findings), entry.id);
    for (const finding of entry.lint.findings) {
      assert.equal(finding.ruleId, ruleName, `${entry.id}: configuration/parser messages are not rule evidence`);
      assert.equal(finding.severity, 2);
      assert.equal(finding.fatal, undefined);
      assert(anchors[finding.line - 2], `${entry.id}: finding must identify a real anchor`);
    }
    const positiveNames = entry.lint.findings.map((finding) => anchors[finding.line - 2][0]);
    for (const negative of ['missing-route', 'external', 'protocol-relative', 'blank-target', 'download', 'expression', 'link-component', 'no-href']) {
      assert(!positiveNames.includes(negative), `${entry.id}: ${negative}`);
    }
  }
  assert.deepEqual(findingAnchors('literal'), ['home', 'alpha', 'blog', 'docs-query']);
  assert.deepEqual(findingAnchors('brace-alternatives'), ['home', 'alpha', 'beta', 'blog', 'docs-query']);
  assert.deepEqual(findingAnchors('brace-padded-range'), ['one', 'two', 'three']);
  assert.deepEqual(findingAnchors('brace-step-range'), ['one', 'three', 'five']);
  assert.deepEqual(findingAnchors('explicit-dot'), ['hidden']);
  assert.deepEqual(findingAnchors('default-context-cwd'), ['context']);
  assert.deepEqual(findingAnchors('explicit-uses-process-cwd'), ['home', 'alpha', 'blog', 'docs-query']);
  assert.deepEqual(findingAnchors('explicit-process-cwd-differs'), []);
  // The original rule recognizes app/page.tsx's '/', but does not report these
  // nested app anchors. Freeze that observed behavior rather than correcting it.
  assert.deepEqual(findingAnchors('app-only-real-rule-behavior'), ['home']);
  assert.deepEqual(findingAnchors('grammar-quoted-alternatives'), ['grammar-alpha', 'grammar-beta']);
  assert.deepEqual(findingAnchors('grammar-quoted-short-alternatives'), ['grammar-a', 'grammar-b']);
  assert.deepEqual(findingAnchors('grammar-single-quoted-alternatives'), ['grammar-a', 'grammar-b']);
  assert.deepEqual(findingAnchors('grammar-bracket-with-braces'), ['grammar-a', 'grammar-b', 'grammar-comma', 'grammar-open-brace', 'grammar-close-brace']);
  assert.deepEqual(findingAnchors('grammar-bracket-literal-square'), ['grammar-a', 'grammar-square-a']);
  assert.deepEqual(findingAnchors('grammar-escaped-star-normalized'), ['grammar-b']);
  assert.deepEqual(findingAnchors('grammar-quoted-padded-range'), []);
  assert.deepEqual(findingAnchors('grammar-quoted-step-range'), []);
  const numberFindings = ['grammar-number-one', 'grammar-number-two', 'grammar-number-three'];
  assert.deepEqual(findingAnchors('grammar-small-scientific-numeric'), numberFindings);
  assert.deepEqual(findingAnchors('grammar-small-whitespace-numeric'), numberFindings);
  assert.deepEqual(findingAnchors('grammar-small-descending-scientific'), numberFindings);
  assert.deepEqual(findingAnchors('grammar-small-stepped-scientific'), ['grammar-number-one', 'grammar-number-three']);
  assert.deepEqual(findingAnchors('grammar-small-mixed-numeric-char'), ['grammar-b', 'grammar-number-one']);
  assert.deepEqual(findingAnchors('grammar-small-alpha-range'), ['grammar-a', 'grammar-b']);
}

if (captureOriginal) {
  // Explicit capture verifies the unpatched package and meaningful findings
  // before writing; an isolated prefix never changes root dependencies.
  const captured = await collectOriginal();
  if (existsSync(oraclePath)) {
    const previous = JSON.parse(readFileSync(oraclePath, 'utf8'));
    assert.equal(captured.oracle.rootUtilitySha256, previous.oracle.rootUtilitySha256);
    assert.equal(captured.oracle.fastGlobIndexSha256, previous.oracle.fastGlobIndexSha256);
    assert.deepEqual(captured.oracle.ruleHashes, previous.oracle.ruleHashes);
    for (const entry of previous.roots) {
      const observed = captured.roots.find((item) => item.id === entry.id);
      assert.deepEqual(observed?.expected, entry.expected, `Retain original roots: ${entry.id}`);
      assert.deepEqual(observed?.lint, entry.lint, `Retain original Linter findings: ${entry.id}`);
    }
    for (const entry of previous.apis) {
      assert.deepEqual(captured.apis.find((item) => item.id === entry.id), entry, `Retain original APIs: ${entry.id}`);
    }
    if (previous.symlinkCycle) assert.deepEqual(captured.symlinkCycle, previous.symlinkCycle);
    captured.oracle.capturedAt = previous.oracle.capturedAt;
    captured.oracle.linterCapture = {
      capturedAt: new Date().toISOString(),
      method: 'Explicit capture from original Next 16.3.0 and fast-glob 3.3.1 with a JSX configuration selector; all pre-install root/API observations and original source hashes verified unchanged.',
    };
  }
  writeFileSync(oraclePath, `${JSON.stringify(captured, null, 2)}\n`);
  console.log(`Saved original oracle: ${captured.roots.length} root/Linter cases, ${captured.apis.length} async/sync/stream cases, ${Object.keys(captured.oracle.ruleHashes).length} rule hashes.`);
} else {
  const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'));
  test('oracle is pinned to the original installed Next and fast-glob', () => {
    assert.equal(oracle.oracle.nextPlugin, '16.3.0');
    assert.equal(oracle.oracle.fastGlob, '3.3.1');
    assert.equal(oracle.oracle.node, 'v22.23.2');
    assert.equal(oracle.oracle.platform, 'linux');
    validateLintOracle(oracle.roots);
    assert.deepEqual(oracle.filesystem, specification);
    assert.deepEqual(oracle.anchors, anchors);
    assert.equal(oracle.roots.length, rootCases.length);
    assert.equal(oracle.apis.length, apiCases.length);
    assert.deepEqual(oracle.roots.map(({ expected, lint, ...entry }) => entry), rootCases);
    assert.deepEqual(oracle.apis.map(({ expected, ...entry }) => entry), apiCases);
    assert.equal(nextPackage.version, oracle.oracle.nextPlugin);
    assert.equal(hash(nextRequire.resolve('./dist/utils/get-root-dirs.js')), oracle.oracle.rootUtilitySha256);
    assert.equal(Object.keys(oracle.oracle.ruleHashes).length, 22);
    const rulesDir = path.join(path.dirname(nextRequire.resolve('./package.json')), 'dist/rules');
    assert.deepEqual(readdirSync(rulesDir).filter((file) => file.endsWith('.js')).sort(), Object.keys(oracle.oracle.ruleHashes));
    for (const [file, expected] of Object.entries(oracle.oracle.ruleHashes)) assert.equal(hash(path.join(rulesDir, file)), expected, file);
  });

  for (const entry of oracle.roots) {
    test(`rootDir parity: ${entry.id}`, () => {
      const dir = fixture();
      try { assert.deepEqual(rootsFor(entry, dir), entry.expected); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    });
    test(`Linter parity: ${entry.id}`, () => {
      const dir = fixture();
      try { assert.deepEqual(lintFor(entry, dir), entry.lint); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  for (const entry of oracle.apis) {
    test(`fast-glob API parity: ${entry.id}`, async () => {
      const dir = fixture();
      try {
        const options = { ...entry.options, cwd: path.resolve(dir, entry.processCwd ?? '.') };
        assert.deepEqual(entriesFor(fg.sync(entry.patterns, options), dir), entry.expected, 'sync');
        assert.deepEqual(entriesFor(fg.globSync(entry.patterns, options), dir), entry.expected, 'globSync');
        assert.deepEqual(entriesFor(await fg(entry.patterns, options), dir), entry.expected, 'callable async');
        assert.deepEqual(entriesFor(await fg.glob(entry.patterns, options), dir), entry.expected, 'glob async');
        const entries = [];
        for await (const item of fg.stream(entry.patterns, options)) entries.push(item);
        assert.deepEqual(entriesFor(entries, dir), entry.expected, 'stream');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test('fork identity, source provenance, archive and lock agree', () => {
    assert.equal(process.versions.node.split('.')[0], '22');
    assert.equal(process.platform, 'linux');
    assert.equal(fgPackage.version, '3.3.1-cvg.1');
    const provenance = JSON.parse(readFileSync(path.join(projectDir, 'vendor/fast-glob.provenance.json'), 'utf8'));
    assert.equal(provenance.upstream.name, 'fast-glob');
    assert.equal(provenance.upstream.version, '3.3.1');
    assert.equal(provenance.patch.version, fgPackage.version);
    assert.equal(provenance.upstream.files['out/index.js'], oracle.oracle.fastGlobIndexSha256);
    assert.deepEqual(provenance.patch.modified.toSorted(), ['out/index.js', 'out/utils/pattern.js', 'package.json']);
    const bounded = provenance.boundedBraces;
    assert.equal(bounded.upstream.url, 'https://registry.npmjs.org/braces/-/braces-3.0.3.tgz');
    assert.equal(bounded.upstream.integrity, 'sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==');
    const destinations = Object.fromEntries(Object.keys(originalBracesFiles).map((file) => [`out/utils/bounded-braces/${path.posix.basename(file)}`, file]));
    assert.deepEqual(Object.keys(bounded.sources).toSorted(), Object.keys(destinations).toSorted());
    const added = ['out/utils/safe-pattern.cjs', 'out/utils/bounded-braces/limits.cjs', ...Object.keys(destinations)].toSorted();
    assert.deepEqual(provenance.patch.added.toSorted(), added);
    assert.deepEqual(Object.keys(provenance.patch.files).toSorted(), [...Object.keys(provenance.upstream.files), ...added].toSorted());
    const directory = path.dirname(nextRequire.resolve('fast-glob/package.json'));
    for (const [file, expected] of Object.entries(provenance.patch.files)) assert.equal(hash(path.join(directory, file)), expected, `Installed fork: ${file}`);
    for (const [file, expected] of Object.entries(provenance.upstream.files)) {
      if (!provenance.patch.modified.includes(file)) assert.equal(provenance.patch.files[file], expected, `Unchanged upstream: ${file}`);
      else assert.notEqual(provenance.patch.files[file], expected, `Actual source change: ${file}`);
    }
    assert.deepEqual(readFileSync(path.join(directory, 'out/utils/safe-pattern.cjs')), readFileSync(path.join(projectDir, 'scripts/fast-glob-safe-pattern.cjs')));
    assert.deepEqual(readFileSync(path.join(directory, 'out/utils/bounded-braces/limits.cjs')), readFileSync(path.join(projectDir, 'scripts/fast-glob-brace-limits.cjs')));
    for (const [destination, source] of Object.entries(destinations)) {
      const record = bounded.sources[destination];
      const originalHash = originalBracesFiles[source];
      assert.equal(record.source, source);
      assert.equal(record.originalSha256, originalHash, `Pinned original braces source: ${source}`);
      assert.equal(bounded.upstream.files[source], originalHash);
      assert.equal(record.patchedSha256, provenance.patch.files[destination]);
      assert.equal(hash(path.join(directory, destination)), record.patchedSha256, `Installed bounded braces: ${destination}`);
      if (source === 'LICENSE' || source === 'lib/constants.js') assert.equal(record.patchedSha256, originalHash);
      else assert.notEqual(record.patchedSha256, originalHash, `Actual sink/source hardening: ${source}`);
    }
    assert(!existsSync(path.join(directory, 'out/utils/bounded-braces/index.js')));
    assert(!existsSync(path.join(directory, 'out/utils/bounded-braces/compile.js')));
    assert.equal(fgPackage.dependencies.picomatch, '4.0.7');
    assert.equal(fgPackage.dependencies['fill-range'], '7.1.1');
    assert(!Object.hasOwn(fgPackage.dependencies, 'brace-expansion'));
    assert(!Object.hasOwn(fgPackage.dependencies, 'braces'));
    assert(!Object.hasOwn(fgPackage.dependencies, 'micromatch'));
    const forkRequire = createRequire(nextRequire.resolve('fast-glob'));
    assert.equal(forkRequire('picomatch/package.json').version, '4.0.7');
    assert.equal(forkRequire('fill-range/package.json').version, '7.1.1');
    const bytes = readFileSync(path.join(projectDir, provenance.archive.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.archive.sha256);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const lock = JSON.parse(readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'));
    const lockKey = path.relative(projectDir, directory).split(path.sep).join('/');
    assert.equal(lock.packages[lockKey].version, fgPackage.version);
    assert.equal(lock.packages[lockKey].integrity, integrity, 'Lock must refresh integrity when the archive changes at the same path');
    assert.equal(lock.packages[lockKey].resolved, `file:${provenance.archive.path}`);
    const manifest = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    assert.equal(manifest.overrides['fast-glob'], '$fast-glob');
    assert.equal(manifest.devDependencies['fast-glob'], `file:${provenance.archive.path}`);
  });

  test('bounded hostile patterns explicitly reject with RangeError through helpers and installed APIs', () => {
    const dir = fixture();
    try {
      const cases = hostileCases();
      const report = runProbe('hostile', dir, cases);
      const checks = cases.reduce((count, item) => count + (item.expansion ? 6 : 9), 0);
      assert.deepEqual(report, { cases: cases.length, checks });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('exact supported limits remain usable without silently truncating expansion', () => {
    assert.equal(fgPackage.version, '3.3.1-cvg.1');
    const helper = nextRequire('fast-glob/out/utils/safe-pattern.cjs');
    const accepted = ['a'.repeat(4096), '{'.repeat(32) + 'a' + '}'.repeat(32), '@('.repeat(32) + 'a' + ')'.repeat(32), '{a}'.repeat(64)];
    for (const pattern of accepted) {
      assert.doesNotThrow(() => helper.assertSafePattern(pattern));
      assert.doesNotThrow(() => helper.scan(pattern, { parts: true }));
      assert(helper.makeRe(pattern) instanceof RegExp);
    }
    const expansion = helper.expandBraces('{0001..1000}');
    assert.equal(expansion.length, 1000);
    assert.equal(expansion[0], '0001');
    assert.equal(expansion[999], '1000');
    for (const pattern of ['{1e3..1}', '{1..1999..2}', '{1999..1..2}']) {
      assert.equal(helper.expandBraces(pattern).length, 1000, `Supported range boundary: ${pattern}`);
    }
    assert.deepEqual(helper.expandBraces('{alpha,alpha,beta}'), ['alpha', 'beta']);
    const dir = fixture();
    try { assert.deepEqual(fg.sync('apps/{0001..1000}', { cwd: dir, onlyDirectories: true }), []); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('private braces parser and AST sinks reject cycles and allocation excess in a bounded child', () => {
    const dir = fixture();
    try {
      const cases = hostileCases();
      assert.deepEqual(runProbe('private-ast', dir, cases), {
        astChecks: 75, flattenChecks: 9,
        rangeChecks: cases.filter((item) => item.expansion && item.pattern.includes('..')).length * 6,
        optionChecks: 4, productChecks: 2, parserChecks: 23,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('symlink cycles retain the original bounded walker result or ELOOP', () => {
    const dir = fixture();
    try {
      assert.deepEqual(Object.keys(oracle.symlinkCycle), ['sync', 'async', 'stream', 'roots']);
      const originalRoots = Array.from({ length: 40 }, (_, index) => `cycle${'/loop'.repeat(index + 1)}`).sort();
      for (const result of Object.values(oracle.symlinkCycle)) assert.deepEqual(result, { roots: originalRoots });
      // Unbounded symlink traversal can return ELOOP even for the unpatched
      // walker. Successful traversals must still match every original path;
      // an empty/partial result, other error or timeout remains a failure.
      const observed = runProbe('cycle', dir);
      assert.deepEqual(Object.keys(observed), Object.keys(oracle.symlinkCycle));
      for (const [name, result] of Object.entries(observed)) {
        if (result.error) assert.deepEqual(result, { error: { name: 'Error', code: 'ELOOP' } }, name);
        else assert.deepEqual(result, oracle.symlinkCycle[name], name);
      }
      // A finite depth avoids the kernel limit and must succeed identically
      // through all three APIs; ELOOP is not accepted for this case.
      const roots = ['cycle/loop', 'cycle/loop/loop', 'cycle/loop/loop/loop'];
      assert.deepEqual(runProbe('cycle-bounded', dir), {
        sync: { roots }, async: { roots }, stream: { roots },
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
