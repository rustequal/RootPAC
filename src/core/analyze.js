import { parse } from "../../vendor/acorn.js";
import { covers, maskDomain } from "./hosts.js";
import { maskProblem } from "./names.js";

const PARSE_OPTIONS = Object.freeze({
  ecmaVersion: "latest",
  sourceType: "script",
  locations: true,
  allowHashBang: false,
});

const DIRECTIVES = new Set(["root", "deny", "bypass"]);
const TOP_LEVEL = new Set(["deny", "bypass"]);
const RESERVED = new Set(["__user", "__fuel"]);
const ENTRY = "FindProxyForURL";

const BINDING_ENTRIES = {
  VariableDeclarator: new Set(["id"]),
  FunctionDeclaration: new Set(["id", "params"]),
  FunctionExpression: new Set(["id", "params"]),
  ArrowFunctionExpression: new Set(["params"]),
  ClassDeclaration: new Set(["id"]),
  ClassExpression: new Set(["id"]),
  CatchClause: new Set(["param"]),
};

const BINDING_PATTERNS = {
  ObjectPattern: new Set(["properties"]),
  ArrayPattern: new Set(["elements"]),
  RestElement: new Set(["argument"]),
  AssignmentPattern: new Set(["left"]),
  Property: new Set(["value"]),
};

export function parseScript(text) {
  return parse(text, PARSE_OPTIONS);
}

function isValid(mask, directive) {
  return typeof mask === "string" && maskProblem(mask, directive) === null;
}

export function isValidMask(mask) {
  return isValid(mask, "deny");
}

export function isValidRoot(mask) {
  return isValid(mask, "root");
}

export function isValidBypassMask(mask) {
  return isValid(mask, "bypass");
}

export function denyOverlapsBypass(deny, bypass) {
  const denied = maskDomain(deny);
  const bypassed = maskDomain(bypass);
  return covers(denied, bypassed) || (bypass.startsWith("*.") && covers(bypassed, denied));
}

function isNode(value) {
  return typeof value === "object" && value !== null && typeof value.type === "string";
}

function isNonReference(parent, key) {
  switch (parent.type) {
    case "MemberExpression":
      return key === "property" && !parent.computed;
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
      return key === "key" && !parent.computed;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return key === "label";
    case "MetaProperty":
      return true;
    default:
      return false;
  }
}

function childBinding(node, key, binding) {
  if (BINDING_ENTRIES[node.type]?.has(key)) return true;
  return binding && BINDING_PATTERNS[node.type]?.has(key) === true;
}

function hasUpperCase(text) {
  for (const c of text) {
    if (c >= "A" && c <= "Z") return true;
  }
  return false;
}

function maskError(value, directive, problem) {
  if (value === "") return `${directive}() mask must not be empty`;
  const mask = JSON.stringify(value);
  if (hasUpperCase(value)) return `${directive}() mask must be lowercase: ${mask}`;
  if (problem.kind === "reason") return `${directive}() mask ${mask} ${problem.reason}`;
  if (problem.kind === "wildcard" && isValidRoot(value.slice(2))) {
    return `root() takes a domain and always covers all its subdomains: write ${JSON.stringify(value.slice(2))} instead of ${mask}`;
  }
  if (directive === "bypass") return `bypass() mask must be a domain, a zone or *.domain: ${mask}`;
  if (directive === "root") return `root() mask must be a domain: ${mask}`;
  return `${directive}() mask must be a domain or *.domain: ${mask}`;
}

function analyzeProgram(program) {
  const errors = [];
  const roots = [];
  const deny = [];
  const bypass = [];
  const fail = (node, message) => errors.push({ node, message });

  const entries = program.body.filter(
    (stmt) => stmt.type === "FunctionDeclaration" && stmt.id.name === ENTRY,
  );
  if (entries.length === 0) {
    errors.push({ line: 1, column: 1, message: `Missing top-level function ${ENTRY}` });
  }
  entries.slice(1).forEach((stmt) => fail(stmt.id, `Duplicate top-level function ${ENTRY}`));
  entries
    .filter((stmt) => stmt.async || stmt.generator)
    .forEach((stmt) => fail(stmt.id, `${ENTRY} must be a plain function, not async or generator`));

  const topLevel = new Set(
    program.body
      .filter(
        (stmt) =>
          stmt.type === "ExpressionStatement" &&
          stmt.expression.type === "CallExpression" &&
          !stmt.expression.optional &&
          stmt.expression.callee.type === "Identifier" &&
          TOP_LEVEL.has(stmt.expression.callee.name),
      )
      .map((stmt) => stmt.expression),
  );

  const checkMaskArgs = (call, directive, arity) => {
    const args = call.arguments;
    if (args.some((arg) => arg.type === "SpreadElement")) {
      fail(call, `${directive}() does not accept spread arguments`);
      return null;
    }
    if (args.length !== arity) {
      fail(call, `${directive}() requires exactly ${arity} argument${arity === 1 ? "" : "s"}`);
      return null;
    }
    const literal = args[arity - 1];
    if (literal.type !== "Literal" || typeof literal.value !== "string") {
      fail(literal, `${directive}() mask must be a string literal`);
      return null;
    }
    const problem = maskProblem(literal.value, directive);
    if (problem !== null) {
      fail(literal, maskError(literal.value, directive, problem));
      return null;
    }
    return { mask: literal.value, start: literal.start, node: literal };
  };

  const onCall = (call) => {
    const name = call.callee.name;
    if (name === "root") {
      const found = checkMaskArgs(call, "root", 2);
      if (found) roots.push(found);
      return;
    }
    if (!topLevel.has(call)) {
      fail(call, `${name}() must be a standalone top-level statement`);
      return;
    }
    const found = checkMaskArgs(call, name, 1);
    if (found) (name === "deny" ? deny : bypass).push(found);
  };

  const onIdentifier = (node, parent, key, binding) => {
    const { name } = node;
    if (RESERVED.has(name)) {
      fail(node, `Identifier ${name} is reserved by RootPAC`);
      return;
    }
    if (!DIRECTIVES.has(name)) return;
    if (binding) {
      fail(node, `Identifier ${name} must not be declared`);
      return;
    }
    if (parent.type === "CallExpression" && key === "callee") {
      onCall(parent);
      return;
    }
    fail(node, `${name} may only be called directly`);
  };

  const visit = (node, parent, key, binding) => {
    if (node.type === "Identifier") {
      if (parent === null || !isNonReference(parent, key)) onIdentifier(node, parent, key, binding);
      return;
    }
    for (const childKey of Object.keys(node)) {
      const value = node[childKey];
      const childIsBinding = childBinding(node, childKey, binding);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) visit(item, node, childKey, childIsBinding);
        }
      } else if (isNode(value)) {
        visit(value, node, childKey, childIsBinding);
      }
    }
  };

  visit(program, null, null, false);

  for (const found of bypass) {
    const clash = deny.find((item) => denyOverlapsBypass(item.mask, found.mask));
    if (clash !== undefined) fail(found.node, `bypass() mask ${JSON.stringify(found.mask)} overlaps deny() mask ${JSON.stringify(clash.mask)}`);
  }
  for (const found of deny) {
    const covered = roots.find((item) => covers(maskDomain(found.mask), item.mask));
    if (covered !== undefined) fail(found.node, `deny() mask ${JSON.stringify(found.mask)} covers root() mask ${JSON.stringify(covered.mask)}`);
  }

  return { errors, roots: collapse(roots), deny: collapse(deny), bypass: collapse(bypass) };
}

function collapse(found) {
  return [...new Set(found.sort((a, b) => a.start - b.start).map((item) => item.mask))];
}

function position(error) {
  if (error.node === undefined) return { line: error.line, column: error.column, message: error.message };
  const { line, column } = error.node.loc.start;
  return { line, column: column + 1, message: error.message };
}

function byPosition(a, b) {
  return a.line - b.line || a.column - b.column;
}

export function analyzeUserPac(text) {
  if (typeof text !== "string") throw new TypeError("User PAC must be a string");
  let program;
  try {
    program = parseScript(text);
  } catch (error) {
    if (!(error instanceof SyntaxError) || error.loc === undefined) throw error;
    return {
      ok: false,
      errors: [
        {
          line: error.loc.line,
          column: error.loc.column + 1,
          message: error.message.replace(/ \(\d+:\d+\)$/, ""),
        },
      ],
    };
  }
  const { errors, roots, deny, bypass } = analyzeProgram(program);
  if (errors.length > 0) return { ok: false, errors: errors.map(position).sort(byPosition) };
  return { ok: true, roots, deny, bypass };
}
