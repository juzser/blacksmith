import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function start() {
  const load = (name) => import(pathToFileURL(join(process.cwd(), "src", `${name}.js`)).href);
  const db = (await load("db")).openDatabase(":memory:");
  (await load("migrate")).migrate(db);
  const server = (await load("server")).createServer(db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "content-type": "application/json" };
  const post = (path, body) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { db, base, post, close: () => new Promise((resolve) => server.close(resolve)) };
}
