import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("npm start binds loopback only and names the bound address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sample-app-listen-"));
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, "test.db") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const pid = child.pid;
  try {
    const line = await new Promise((resolve, reject) => {
      let out = "";
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`exited early: ${out}`)));
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const m = out.match(/listening on http:\/\/(\S+)/);
        if (m) resolve(m[1]);
      });
    });
    const match = line.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    assert.ok(match, `unparseable start-up line: ${line}`);
    const host = match[1].replace(/^\[|\]$/g, "");
    assert.ok(net.isIP(host), `start-up line must name an IP address, got ${host}`);
    assert.ok(host === "::1" || host.startsWith("127."), `not loopback: ${host}`);
    assert.equal(Number(match[2]), port);
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(pid);
    rmSync(dir, { recursive: true, force: true });
  }
});
