import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../../../support.js";

test("notes can be pinned and pinned notes are listed first", async () => {
  const app = await start();
  try {
    await app.post("/api/notes", { title: "Plain" });
    const pinned = await (await app.post("/api/notes", { title: "Pinned", pinned: true })).json();
    assert.equal(Boolean(pinned.pinned), true);
    const list = await (await fetch(`${app.base}/api/notes`)).json();
    assert.deepEqual(list.map((n) => n.title), ["Pinned", "Plain"]);
    assert.equal(Boolean(list[1].pinned), false);
  } finally {
    await app.close();
  }
});
