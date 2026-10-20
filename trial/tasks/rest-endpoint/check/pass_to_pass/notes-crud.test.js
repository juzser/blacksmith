import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../../../support.js";

test("notes can be created, listed and fetched by id", async () => {
  const app = await start();
  try {
    const made = await (await app.post("/api/notes", { title: "First", body: "text" })).json();
    const list = await (await fetch(`${app.base}/api/notes`)).json();
    assert.deepEqual(list.map((n) => n.id), [made.id]);
    const one = await fetch(`${app.base}/api/notes/${made.id}`);
    assert.equal(one.status, 200);
    assert.equal((await one.json()).title, "First");
    assert.equal((await fetch(`${app.base}/api/notes/999`)).status, 404);
  } finally {
    await app.close();
  }
});
