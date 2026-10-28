import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../../../support.js";

test("the front end assets are still served with their content types", async () => {
  const app = await start();
  try {
    const html = await fetch(`${app.base}/`);
    assert.match(html.headers.get("content-type"), /text\/html/);
    assert.match(await html.text(), /id="note-form"/);
    const js = await fetch(`${app.base}/app.js`);
    assert.match(js.headers.get("content-type"), /javascript/);
  } finally {
    await app.close();
  }
});
