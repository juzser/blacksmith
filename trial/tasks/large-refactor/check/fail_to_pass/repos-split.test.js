import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const load = (p) => import(pathToFileURL(join(process.cwd(), p)).href);

import { readdirSync, readFileSync } from "node:fs";

test("the notes data-access code is split into several small modules", () => {
  const dir = join(process.cwd(), "src", "repos");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 3, `expected at least 3 modules in src/repos, found ${files.length}`);
  for (const f of files) {
    const lines = readFileSync(join(dir, f), "utf8").trimEnd().split("\n").length;
    assert.ok(lines <= 50, `${f} has ${lines} lines`);
  }
});
