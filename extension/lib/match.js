// matches says whether a URL is one of a claim pattern's pages, as Chrome's
// registration matches it (internal/pattern.Match is the bridge's copy): no
// port matches every port, "*." covers the host and its subdomains, and the
// path glob sees the query but never the hash. The worker uses it to tell a
// tab whether its page is still claimed.

const DEFAULT_PORTS = { "http:": "80", "https:": "443" };

function glob(pattern, s) {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  return re.test(s);
}

export function matches(pattern, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const m = /^(\*|https?):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, authority, path] = m;
  if (scheme !== "*" && `${scheme}:` !== u.protocol) return false;

  const [, host, port] = /^(.*?)(?::(\d+))?$/.exec(authority);
  const hostname = u.hostname.toLowerCase();
  if (host !== "*") {
    if (host.startsWith("*.")) {
      const base = host.slice(2);
      if (hostname !== base && !hostname.endsWith(`.${base}`)) return false;
    } else if (hostname !== host) {
      return false;
    }
  }
  if (port && (u.port || DEFAULT_PORTS[u.protocol]) !== String(Number(port))) return false;
  return glob(path, `${u.pathname}${u.search}`);
}
