import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BODY_BYTES } from "../src/http.js";
import { startApp } from "./helpers.js";

test("a body just over the cap answers 413 and the server keeps serving", async () => {
  const app = await startApp();
  try {
    const big = JSON.stringify({ title: "x".repeat(1024 * 1024 + 16) });
    const res = await fetch(`${app.base}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    });
    assert.equal(res.status, 413);
    const ok = await app.call("POST", "/api/notes", { title: "after" });
    assert.equal(ok.status, 201);
  } finally {
    await app.close();
  }
});

test("a body under the cap is parsed as before, invalid JSON still 400", async () => {
  const app = await startApp();
  try {
    assert.ok(MAX_BODY_BYTES >= 1024 * 1024);
    const ok = await app.call("POST", "/api/notes", { title: "x".repeat(1000) });
    assert.equal(ok.status, 201);
    const bad = await fetch(`${app.base}/api/notes`, { method: "POST", body: "{nope" });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});
