import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const load = (p) => import(pathToFileURL(join(process.cwd(), p)).href);

test("describeStats words the counts with singular and plural forms", async () => {
  const { describeStats } = await load("public/summary.js");
  assert.equal(describeStats({ notes: 3, tags: 1 }), "3 notes, 1 tag");
  assert.equal(describeStats({ notes: 1, tags: 2 }), "1 note, 2 tags");
  assert.equal(describeStats({ notes: 0, tags: 0 }), "0 notes, 0 tags");
});
