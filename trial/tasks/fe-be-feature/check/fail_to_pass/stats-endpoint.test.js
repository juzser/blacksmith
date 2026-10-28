import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../../../support.js";

test("GET /api/stats counts notes and tags", async () => {
  const app = await start();
  try {
    const tag = await (await app.post("/api/tags", { name: "t" })).json();
    await app.post("/api/notes", { title: "A", tags: [tag.id] });
    await app.post("/api/notes", { title: "B" });
    const res = await fetch(`${app.base}/api/stats`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { notes: 2, tags: 1 });
  } finally {
    await app.close();
  }
});
