import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp } from "./helpers.js";

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

async function seed() {
  const tag = await app.call("POST", "/api/tags", { name: `t${Math.random()}` });
  const note = await app.call("POST", "/api/notes", { title: "orig", tags: [tag.json.id] });
  return { tag: tag.json, note: note.json };
}

test("updating a note with an unknown tag id is a client error and changes nothing", async () => {
  const { tag, note } = await seed();
  const res = await app.call("PUT", `/api/notes/${note.id}`, { title: "changed", tags: [9999] });
  assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
  const got = await app.call("GET", `/api/notes/${note.id}`);
  assert.equal(got.json.title, "orig");
  assert.deepEqual(
    got.json.tags.map((t) => t.id),
    [tag.id],
  );
});

test("a valid tag mixed with an unknown one rejects the whole update", async () => {
  const { note } = await seed();
  const other = await app.call("POST", "/api/tags", { name: "other" });
  const before = await app.call("GET", `/api/notes/${note.id}`);
  const res = await app.call("PUT", `/api/notes/${note.id}`, {
    title: "changed",
    tags: [other.json.id, 9999],
  });
  assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
  const after = await app.call("GET", `/api/notes/${note.id}`);
  assert.deepEqual(after.json, before.json);
});

test("updating a note with existing tags still replaces its tags", async () => {
  const { note } = await seed();
  const next = await app.call("POST", "/api/tags", { name: "next" });
  const res = await app.call("PUT", `/api/notes/${note.id}`, {
    title: "renamed",
    tags: [next.json.id],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.title, "renamed");
  assert.deepEqual(res.json.tags, [{ id: next.json.id, name: "next" }]);
});
