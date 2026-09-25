import { parseScript } from "./analyze.js";

const CALL = "__fuel();";
const LOOPS = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function isNode(value) {
  return typeof value === "object" && value !== null && typeof value.type === "string";
}

function children(node) {
  const found = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) found.push(...value.filter(isNode));
    else if (isNode(value)) found.push(value);
  }
  return found;
}

function directivePrologue(block) {
  let last = null;
  for (const statement of block.body) {
    if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") break;
    last = statement;
  }
  return last;
}

export function instrument(text) {
  const inserts = [];
  const at = (offset, { line, column }, value, closing, depth) => inserts.push({ offset, line, column, value, closing, depth });
  const enterBlock = (block, depth) => at(block.start + 1, { line: block.loc.start.line, column: block.loc.start.column + 1 }, CALL, false, depth);
  const wrap = (node, open, close, depth) => {
    at(node.start, node.loc.start, open, false, depth);
    at(node.end, node.loc.end, close, true, depth);
  };
  const visit = (node, depth) => {
    if (LOOPS.has(node.type)) {
      if (node.body.type === "BlockStatement") enterBlock(node.body, depth);
      else wrap(node.body, `{${CALL}`, "}", depth);
    } else if (FUNCTIONS.has(node.type)) {
      if (node.body.type !== "BlockStatement") wrap(node.body, "(__fuel(), ", ")", depth);
      else {
        const prologue = directivePrologue(node.body);
        if (prologue === null) enterBlock(node.body, depth);
        else at(prologue.end, prologue.loc.end, `;${CALL}`, false, depth);
      }
    }
    for (const child of children(node)) visit(child, depth + 1);
  };
  visit(parseScript(text), 0);
  inserts.sort(
    (a, b) =>
      a.offset - b.offset ||
      Number(b.closing) - Number(a.closing) ||
      (a.closing ? b.depth - a.depth : a.depth - b.depth),
  );
  let code = "";
  let cursor = 0;
  for (const insert of inserts) {
    code += text.slice(cursor, insert.offset) + insert.value;
    cursor = insert.offset;
  }
  code += text.slice(cursor);
  const shifts = inserts.map(({ line, column, value }) => ({ line, column, length: value.length }));
  return { code, shifts };
}

export function originalColumn(shifts, line, column) {
  const target = column - 1;
  let shift = 0;
  for (const insert of shifts) {
    if (insert.line !== line) continue;
    const start = insert.column + shift;
    if (target < start) break;
    if (target < start + insert.length) return insert.column + 1;
    shift += insert.length;
  }
  return target - shift + 1;
}
