import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp } from "./helpers.js";

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

test("creating a note with an unknown tag id is a client error and leaves no note", async () => {
  const res = await app.call("POST", "/api/notes", { title: "a", tags: [9999] });
  assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
  const list = await app.call("GET", "/api/notes");
  assert.deepEqual(list.json, []);
});

test("creating a note with existing tags still links them", async () => {
  const tag = await app.call("POST", "/api/tags", { name: "work" });
  const res = await app.call("POST", "/api/notes", { title: "b", tags: [tag.json.id] });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json.tags, [{ id: tag.json.id, name: "work" }]);
});
