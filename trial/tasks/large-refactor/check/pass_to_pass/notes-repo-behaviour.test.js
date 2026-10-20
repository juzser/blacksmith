import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const load = (p) => import(pathToFileURL(join(process.cwd(), p)).href);

test("the notes repository keeps its behaviour", async () => {
  const { openDatabase } = await load("src/db.js");
  const { migrate } = await load("src/migrate.js");
  const repo = await load("src/repos/notes.js");
  const tags = await load("src/repos/tags.js");
  const db = openDatabase(":memory:");
  migrate(db);
  const a = tags.createTag(db, "a");
  const b = tags.createTag(db, "b");
  const one = repo.createNote(db, { title: "One", body: "x", tags: [a.id, b.id] });
  const two = repo.createNote(db, { title: "Two" });
  assert.deepEqual(one.tags.map((t) => t.name), ["a", "b"]);
  assert.deepEqual(repo.listNotes(db).map((n) => n.title), ["One", "Two"]);
  assert.deepEqual(repo.listNotes(db, { tagId: b.id }).map((n) => n.title), ["One"]);
  const changed = repo.updateNote(db, one.id, { title: "One v2", body: "y", tags: [a.id] });
  assert.deepEqual(changed.tags.map((t) => t.name), ["a"]);
  assert.equal(repo.deleteNote(db, two.id), true);
  assert.equal(repo.getNote(db, two.id), undefined);
});
