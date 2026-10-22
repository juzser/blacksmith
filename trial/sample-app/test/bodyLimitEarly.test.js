import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { MAX_BODY_BYTES } from "../src/http.js";
import { startApp } from "./helpers.js";

test("an oversized body is answered 413 before the client finishes sending", async () => {
  const app = await startApp();
  const port = Number(new URL(app.base).port);
  const socket = net.connect(port, "127.0.0.1");
  try {
    const answer = new Promise((resolve, reject) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (d) => {
        data += d;
        if (data.includes("\r\n\r\n")) resolve(data);
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("no 413 while the body was still open")), 3000);
    });
    // Declare a body far larger than the cap, send just over it, never finish.
    socket.write(
      "POST /api/notes HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n" +
        `content-length: ${MAX_BODY_BYTES * 8}\r\n\r\n`,
    );
    socket.write("x".repeat(MAX_BODY_BYTES + 1024));
    const head = await answer;
    assert.match(head, /^HTTP\/1\.1 413 /);
    assert.match(head, /connection: close/i);
    const ok = await app.call("POST", "/api/notes", { title: "after" });
    assert.equal(ok.status, 201);
  } finally {
    socket.destroy();
    await app.close();
  }
});
