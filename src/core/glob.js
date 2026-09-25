const cache = new Map();

function compile(mask) {
  let re = cache.get(mask);
  if (re === undefined) {
    const source = mask
      .replace(/[\\^$.|+()[\]{}\/-]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    re = new RegExp(`^${source}$`);
    cache.set(mask, re);
  }
  return re;
}

export function matchMask(host, mask) {
  return compile(mask).test(host);
}

export function firstMatch(host, masks) {
  for (const mask of masks) {
    if (matchMask(host, mask)) return mask;
  }
  return null;
}
