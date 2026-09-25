const NON_ASCII = /[^\x00-\x7f]/;

function toAscii(name) {
  if (!NON_ASCII.test(name)) return name;
  const host = new URL(`http://${name}/`).hostname;
  if (host === "") throw new Error(`Public suffix rule ${JSON.stringify(name)} has no ASCII form`);
  return host;
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

  const publicSuffixLength = (labels) => {
    for (let start = 0; start < labels.length; start++) {
      const name = labels.slice(start).join(".");
      if (exceptions.has(name)) return labels.length - start - 1;
      const parent = labels.slice(start + 1).join(".");
      if (rules.has(name) || (start + 1 < labels.length && wildcards.has(parent))) return labels.length - start;
    }
    return 1;
  };

  const labelsOf = (name) => {
    if (typeof name !== "string" || name === "") return null;
    const labels = name.split(".");
    return labels.some((label) => label === "") ? null : labels;
  };

  return {
    isPublicSuffix(name) {
      const labels = labelsOf(name);
      return labels !== null && publicSuffixLength(labels) >= labels.length;
    },

    registrableDomain(host) {
      const labels = labelsOf(host);
      if (labels === null) return null;
      const length = publicSuffixLength(labels);
      return labels.length > length ? labels.slice(-(length + 1)).join(".") : null;
    },
  };
}
