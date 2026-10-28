import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../../../support.js";

test("deleting a tag removes its links to notes from the database", async () => {
  const app = await start();
  try {
    const tag = await (await app.post("/api/tags", { name: "gone" })).json();
    await app.post("/api/notes", { title: "N", tags: [tag.id] });
    const res = await fetch(`${app.base}/api/tags/${tag.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    const left = app.db.prepare("SELECT COUNT(*) AS n FROM note_tags").get().n;
    assert.equal(left, 0);
  } finally {
    await app.close();
  }
});
