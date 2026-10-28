import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../../../support.js";

test("GET /api/notes/search returns notes matching the term in title or body", async () => {
  const app = await start();
  try {
    await app.post("/api/notes", { title: "Groceries", body: "buy MILK" });
    await app.post("/api/notes", { title: "Milkshake plan", body: "" });
    await app.post("/api/notes", { title: "Other", body: "nothing" });
    const res = await fetch(`${app.base}/api/notes/search?q=milk`);
    assert.equal(res.status, 200);
    const found = await res.json();
    assert.deepEqual(found.map((n) => n.title).sort(), ["Groceries", "Milkshake plan"]);
    assert.ok(Array.isArray(found[0].tags));
    const missing = await fetch(`${app.base}/api/notes/search`);
    assert.equal(missing.status, 400);
    assert.ok((await missing.json()).error);
  } finally {
    await app.close();
  }
});
