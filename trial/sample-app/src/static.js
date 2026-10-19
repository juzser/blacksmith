import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = normalize(join(PUBLIC_DIR, rel));
  const ext = file.slice(file.lastIndexOf("."));
  if (!file.startsWith(PUBLIC_DIR) || !TYPES[ext]) return false;
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[ext] });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
