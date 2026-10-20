import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp } from "./helpers.js";

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

test("POST /api/notes creates a note", async () => {
  const res = await app.call("POST", "/api/notes", { title: "First", body: "hello" });
  assert.equal(res.status, 201);
  assert.equal(res.json.title, "First");
  assert.equal(res.json.body, "hello");
  assert.ok(res.json.id > 0);
});

test("POST /api/notes rejects a missing title", async () => {
  const res = await app.call("POST", "/api/notes", { body: "x" });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /title/);
});

test("GET /api/notes lists notes and GET /api/notes/:id reads one", async () => {
  const made = await app.call("POST", "/api/notes", { title: "Listed" });
  const list = await app.call("GET", "/api/notes");
  assert.equal(list.status, 200);
  assert.ok(list.json.some((n) => n.id === made.json.id));
  const one = await app.call("GET", `/api/notes/${made.json.id}`);
  assert.equal(one.json.title, "Listed");
});

test("GET /api/notes/:id answers 404 for an unknown id", async () => {
  const res = await app.call("GET", "/api/notes/99999");
  assert.equal(res.status, 404);
});

test("PUT /api/notes/:id updates a note", async () => {
  const made = await app.call("POST", "/api/notes", { title: "Old" });
  const res = await app.call("PUT", `/api/notes/${made.json.id}`, { title: "New", body: "b" });
  assert.equal(res.status, 200);
  assert.equal(res.json.title, "New");
  assert.equal(res.json.body, "b");
});

test("DELETE /api/notes/:id removes a note", async () => {
  const made = await app.call("POST", "/api/notes", { title: "Gone" });
  const del = await app.call("DELETE", `/api/notes/${made.json.id}`);
  assert.equal(del.status, 204);
  const again = await app.call("GET", `/api/notes/${made.json.id}`);
  assert.equal(again.status, 404);
});

test("a note can carry tags and be filtered by tag", async () => {
  const tag = await app.call("POST", "/api/tags", { name: "work" });
  const made = await app.call("POST", "/api/notes", { title: "Tagged", tags: [tag.json.id] });
  assert.deepEqual(made.json.tags.map((t) => t.name), ["work"]);
  await app.call("POST", "/api/notes", { title: "Untagged" });
  const filtered = await app.call("GET", `/api/notes?tag=${tag.json.id}`);
  assert.deepEqual(filtered.json.map((n) => n.title), ["Tagged"]);
});
