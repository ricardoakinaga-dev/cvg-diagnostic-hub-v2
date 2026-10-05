"use strict";

// Validate before any recursive AST walker, including direct internal calls.
function assertAst(root) {
  const stack = [[root, 0]];
  const seen = new Set();
  const checkedQueues = new Set();
  let textLength = 0;
  let queueItems = 0;
  const checkQueue = (queue) => {
    if (queue === undefined || checkedQueues.has(queue)) return;
    if (!Array.isArray(queue) && typeof queue !== "string") throw new RangeError("Invalid brace AST queue");
    checkedQueues.add(queue);
    const values = flatten(queue);
    queueItems += values.length;
    if (queueItems > 10_000 || values.some((value) => typeof value !== "string" || value.length > 8192)) {
      throw new RangeError("Brace AST queues exceed structural limits");
    }
  };
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== "object" || depth > 64 || seen.has(node) || seen.size >= 10_000) {
      throw new RangeError("Brace AST exceeds structural limits");
    }
    seen.add(node);
    checkQueue(node.queue);
    if (node.value !== undefined) {
      if (typeof node.value !== "string") throw new RangeError("Invalid brace AST text");
      textLength += node.value.length;
      if (textLength > 8192) throw new RangeError("Brace AST exceeds text limits");
    }
    let parent = node.parent;
    let ancestors = 0;
    while (parent) {
      if (++ancestors > 64) throw new RangeError("Brace AST parent chain exceeds structural limits");
      checkQueue(parent.queue);
      parent = parent.parent;
    }
    if (node.nodes) {
      if (!Array.isArray(node.nodes) || node.nodes.length + seen.size + stack.length > 10_000) throw new RangeError("Invalid brace AST children");
      for (let index = node.nodes.length - 1; index >= 0; index -= 1) stack.push([node.nodes[index], depth + 1]);
    }
  }
}

function flatten(...args) {
  const output = [];
  const stack = [[args, 0]];
  let visits = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++visits > 10_000 || depth > 64) throw new RangeError("Brace expansion exceeds structural limits");
    if (Array.isArray(item)) {
      if (item.length > 1000 || stack.length + item.length > 10_000) throw new RangeError("Brace expansion exceeds structural or result limits");
      for (let index = item.length - 1; index >= 0; index -= 1) stack.push([item[index], depth + 1]);
    } else if (item !== undefined) {
      if (output.length >= 1000) throw new RangeError("Brace expansion exceeds 1000 results");
      output.push(item);
    }
  }
  return output;
}

function exceedsRangeLimit(minimum, maximum, step = 1, limit = 1000) {
  // Match fill-range's numeric coercion, including whitespace and exponents.
  const integer = (value) => (typeof value === "number" || typeof value === "string") && Number.isInteger(Number(value));
  let first;
  let last;
  if (integer(minimum) && integer(maximum)) {
    first = Number(minimum);
    last = Number(maximum);
  } else if ((integer(minimum) || String(minimum).length === 1) && (integer(maximum) || String(maximum).length === 1)) {
    first = String(minimum).charCodeAt(0);
    last = String(maximum).charCodeAt(0);
  } else return false;
  const increment = Math.abs(Number(step)) || 1;
  const count = Math.floor(Math.abs(last - first) / increment) + 1;
  const ceiling = Number.isFinite(limit) && limit >= 0 ? Math.min(limit, 1000) : 1000;
  return !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !Number.isFinite(count) || count > ceiling;
}

module.exports = { assertAst, flatten, exceedsRangeLimit };
