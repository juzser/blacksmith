import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp } from "./helpers.js";

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

test("POST /api/tags creates a tag and GET lists it", async () => {
  const made = await app.call("POST", "/api/tags", { name: "home" });
  assert.equal(made.status, 201);
  const list = await app.call("GET", "/api/tags");
  assert.ok(list.json.some((t) => t.name === "home"));
});

test("POST /api/tags rejects a duplicate name with 409", async () => {
  await app.call("POST", "/api/tags", { name: "dup" });
  const res = await app.call("POST", "/api/tags", { name: "dup" });
  assert.equal(res.status, 409);
});

test("POST /api/tags rejects an empty name", async () => {
  const res = await app.call("POST", "/api/tags", { name: "  " });
  assert.equal(res.status, 400);
});

test("DELETE /api/tags/:id removes the tag from its notes", async () => {
  const tag = await app.call("POST", "/api/tags", { name: "temp" });
  const note = await app.call("POST", "/api/notes", { title: "N", tags: [tag.json.id] });
  const del = await app.call("DELETE", `/api/tags/${tag.json.id}`);
  assert.equal(del.status, 204);
  const after = await app.call("GET", `/api/notes/${note.json.id}`);
  assert.deepEqual(after.json.tags, []);
});

test("DELETE /api/tags/:id answers 404 for an unknown id", async () => {
  const res = await app.call("DELETE", "/api/tags/99999");
  assert.equal(res.status, 404);
});
