import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../../../support.js";

test("listing without a filter returns every note, oldest first", async () => {
  const app = await start();
  try {
    await app.post("/api/notes", { title: "A" });
    await app.post("/api/notes", { title: "B" });
    const list = await (await fetch(`${app.base}/api/notes`)).json();
    assert.deepEqual(list.map((n) => n.title), ["A", "B"]);
  } finally {
    await app.close();
  }
});
