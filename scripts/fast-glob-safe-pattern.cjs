"use strict";

const picomatch = require("picomatch");
const parse = require("./bounded-braces/parse");
const expand = require("./bounded-braces/expand");

// Reject excessive complexity before parsing or touching the filesystem.
// These are configuration errors, never a truncated set of lint roots.
function assertSafePattern(pattern) {
  if (typeof pattern !== "string") throw new TypeError("Expected a string pattern");
  if (pattern.length > 4096) throw new RangeError("Glob pattern exceeds 4096 characters");
  let braces = 0;
  let parentheses = 0;
  let groups = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") { braces += 1; groups += 1; }
    if (character === "(") { parentheses += 1; groups += 1; }
    if (character === "}") { braces = Math.max(0, braces - 1); groups += 1; }
    if (character === ")") { parentheses = Math.max(0, parentheses - 1); groups += 1; }
    if (braces + parentheses > 32 || groups > 128) {
      throw new RangeError("Glob pattern exceeds grouping complexity limits");
    }
  }
}

function expandBraces(pattern) {
  assertSafePattern(pattern);
  // Preserve micromatch's exact lexical semantics. The vendored AST walkers
  // and combinations enforce their bounds directly, before allocating output.
  const opening = pattern.indexOf("{");
  if (opening === -1 || pattern.indexOf("}", opening) === -1 || pattern.length < 3) return [pattern];
  const patterns = expand(parse(pattern));
  if (patterns.length > 1000) throw new RangeError("Glob pattern expands to more than 1000 patterns");
  return [...new Set(patterns)];
}

function scan(pattern, options) {
  assertSafePattern(pattern);
  return picomatch.scan(pattern, options);
}

function makeRe(pattern, options) {
  assertSafePattern(pattern);
  return picomatch.makeRe(pattern, options);
}

module.exports = { assertSafePattern, expandBraces, scan, makeRe };
