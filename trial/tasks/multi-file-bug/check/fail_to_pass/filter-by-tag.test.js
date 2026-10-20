import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../../../support.js";

test("GET /api/notes?tag=<id> returns only the notes carrying that tag", async () => {
  const app = await start();
  try {
    const tag = await (await app.post("/api/tags", { name: "work" })).json();
    await app.post("/api/notes", { title: "Tagged", tags: [tag.id] });
    await app.post("/api/notes", { title: "Plain" });
    const list = await (await fetch(`${app.base}/api/notes?tag=${tag.id}`)).json();
    assert.deepEqual(list.map((n) => n.title), ["Tagged"]);
  } finally {
    await app.close();
  }
});
