const NON_ASCII = /[^\x00-\x7f]/;
// Every build of the System PAC, the rules and the PAC routes asks about every learned host again; the answers of one
// list are kept, and forgotten all at once when there are too many.
const MAX_ANSWERS = 65_536;

function toAscii(name) {
  if (!NON_ASCII.test(name)) return name;
  const host = new URL(`http://${name}/`).hostname;
  if (host === "") throw new Error(`Public suffix rule ${JSON.stringify(name)} has no ASCII form`);
  return host;
}

function isName(name) {
  return typeof name === "string" && name !== "" && name[0] !== "." && name[name.length - 1] !== "." && !name.includes("..");
}

function remembered(find) {
  const answers = new Map();
  return (name) => {
    let answer = answers.get(name);
    if (answer === undefined) {
      if (answers.size >= MAX_ANSWERS) answers.clear();
      answer = find(name);
      answers.set(name, answer);
    }
    return answer;
  };
}

export function parsePublicSuffixList(text) {
  if (typeof text !== "string") throw new TypeError("Public suffix list must be a string");
  const rules = new Set();
  const wildcards = new Set();
  const exceptions = new Set();
  for (const line of text.split("\n")) {
    const rule = line.trim().split(/\s/)[0];
    if (rule === "" || rule.startsWith("//")) continue;
    if (rule.startsWith("!")) exceptions.add(toAscii(rule.slice(1).toLowerCase()));
    else if (rule.startsWith("*.")) wildcards.add(toAscii(rule.slice(2).toLowerCase()));
    else rules.add(toAscii(rule.toLowerCase()));
  }
  if (rules.size === 0) throw new Error("Public suffix list has no rules");

  // The labels of the public suffix of a name, by the rules of publicsuffix.org: an exception wins, then the longest
  // rule or wildcard, and `*` when nothing matches. The suffixes are walked from the longest, one label at a time.
  const suffixLabels = (name) => {
    let labels = 1;
    for (let i = 0; i < name.length; i++) if (name[i] === ".") labels++;
    for (let start = 0; ; labels--) {
      const suffix = start === 0 ? name : name.slice(start);
      if (exceptions.has(suffix)) return labels - 1;
      const dot = name.indexOf(".", start);
      if (rules.has(suffix) || (dot >= 0 && wildcards.has(name.slice(dot + 1)))) return labels;
      if (dot < 0) return 1;
      start = dot + 1;
    }
  };

  // The last `count` labels of a name, or null when it has fewer.
  const lastLabels = (name, count) => {
    let end = name.length;
    for (let seen = 0; seen < count; seen++) {
      end = name.lastIndexOf(".", end - 1);
      if (end < 0) return seen === count - 1 ? name : null;
    }
    return name.slice(end + 1);
  };

  const isPublicSuffix = remembered((name) => lastLabels(name, suffixLabels(name) + 1) === null);
  const registrableDomain = remembered((host) => lastLabels(host, suffixLabels(host) + 1));

  return {
    isPublicSuffix: (name) => isName(name) && isPublicSuffix(name),
    registrableDomain: (host) => (isName(host) ? registrableDomain(host) : null),
  };
}
