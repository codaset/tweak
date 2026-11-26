// The static fixture's server: plain files from public/, no framework and no
// reload of its own. Usage: node server.mjs <port>
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const root = join(import.meta.dirname, "public");
const port = Number(process.argv[2]);

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  // Every path without a file is the page, so the page's own pushState
  // targets survive a reload.
  const file = extname(pathname) ? normalize(join(root, pathname)) : join(root, "index.html");
  try {
    if (!file.startsWith(root)) throw new Error("outside public/");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  }
}).listen(port, "127.0.0.1", () => console.log(`static fixture on http://localhost:${port}/`));
