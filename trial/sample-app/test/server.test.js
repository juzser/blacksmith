import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp } from "./helpers.js";

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

test("GET / serves the static front end", async () => {
  const res = await app.call("GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.text, /<title>/);
});

test("static files are served with a matching content type", async () => {
  const res = await app.call("GET", "/app.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
});

test("path traversal is refused", async () => {
  const res = await app.call("GET", "/..%2fpackage.json");
  assert.equal(res.status, 404);
});

test("unknown API route answers 404 JSON", async () => {
  const res = await app.call("GET", "/api/nope");
  assert.equal(res.status, 404);
  assert.ok(res.json.error);
});

test("malformed JSON answers 400", async () => {
  const res = await fetch(`${app.base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});
