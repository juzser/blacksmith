import { openDatabase } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createServer } from "../src/server.js";

export function freshDb() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export async function startApp() {
  const db = freshDb();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    const json = isJson ? JSON.parse(text) : null;
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    db,
    base,
    call,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
