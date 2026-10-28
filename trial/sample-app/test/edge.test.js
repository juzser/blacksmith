import assert from "node:assert/strict";
import { test } from "node:test";
import { startApp } from "./helpers.js";

test("unknown API route answers 404", async () => {
  const app = await startApp();
  try {
    assert.equal((await app.call("GET", "/api/nope")).status, 404);
  } finally {
    await app.close();
  }
});

test("missing note answers 404 on GET, PUT and DELETE", async () => {
  const app = await startApp();
  try {
    assert.equal((await app.call("GET", "/api/notes/999")).status, 404);
    assert.equal((await app.call("PUT", "/api/notes/999", { title: "x" })).status, 404);
    assert.equal((await app.call("DELETE", "/api/notes/999")).status, 404);
  } finally {
    await app.close();
  }
});

test("POST /api/notes rejects tags that are not a list", async () => {
  const app = await startApp();
  try {
    const r = await app.call("POST", "/api/notes", { title: "a", tags: "x" });
    assert.equal(r.status, 400);
  } finally {
    await app.close();
  }
});
