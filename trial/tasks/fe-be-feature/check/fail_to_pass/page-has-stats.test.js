import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../../../support.js";

test("the served page has the stats element and still has the note form", async () => {
  const app = await start();
  try {
    const html = await (await fetch(`${app.base}/`)).text();
    assert.match(html, /id="stats"/);
    assert.match(html, /id="note-form"/);
  } finally {
    await app.close();
  }
});
