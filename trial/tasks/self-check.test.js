import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const run = (...args) =>
  spawnSync("node", [join(here, "self-check.mjs"), ...args], { encoding: "utf8" });
const spec = (n) => `import assert from "node:assert/strict";
import { test } from "node:test";
const { value } = await import(process.cwd() + "/src/value.js");
test("t", () => assert.equal(value, ${n}));
`;

// A one-task corpus in a temp directory; `tweak` edits it before the run.
function corpus(tweak = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "corpus-"));
  const app = join(root, "app");
  const dir = join(root, "tasks", "task-a");
  mkdirSync(join(app, "src"), { recursive: true });
  writeFileSync(join(app, "src", "value.js"), "export const value = 1;\n");
  const check = (group, file, n) => {
    mkdirSync(join(dir, "check", group), { recursive: true });
    writeFileSync(join(dir, "check", group, file), spec(n));
  };
  check("fail_to_pass", "wants-two.test.js", 2);
  check("pass_to_pass", "wants-one.test.js", 1);
  const manifest = {
    kind: "task-a",
    title: "Task A",
    prompt: "prompt.md",
    start_state: null,
    fail_to_pass: "check/fail_to_pass",
    pass_to_pass: "check/pass_to_pass",
    touched_areas: ["src"],
  };
  tweak({ dir, manifest, check });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return run("--tasks-dir", join(root, "tasks"), "--app", app);
}
const patch = (dir, manifest, hunk) => {
  manifest.start_state = "start.patch";
  writeFileSync(join(dir, "start.patch"), `--- a/${hunk}\n+++ b/${hunk}\n@@ -1 +1 @@\n${"-export const value = 1;\n+export const value = 2;\n"}`);
};

test("a consistent task passes and each test file gets a line", () => {
  const r = corpus();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /task-a.*fail_to_pass.*wants-two\.test\.js/);
  assert.match(r.stdout, /task-a.*pass_to_pass.*wants-one\.test\.js/);
});

test("a wrong result on the start state fails the run", () => {
  assert.notEqual(corpus(({ check }) => check("fail_to_pass", "wants-two.test.js", 1)).status, 0);
  assert.notEqual(corpus(({ check }) => check("pass_to_pass", "wants-one.test.js", 2)).status, 0);
});

test("a patch that does not apply fails the run, and a good patch is applied", () => {
  assert.notEqual(corpus(({ dir, manifest }) => patch(dir, manifest, "src/nope.js")).status, 0);
  const good = corpus(({ dir, manifest, check }) => {
    patch(dir, manifest, "src/value.js");
    check("fail_to_pass", "wants-two.test.js", 1);
    check("pass_to_pass", "wants-one.test.js", 2);
  });
  assert.equal(good.status, 0, good.stdout);
});

test("a missing or empty check directory fails the run", () => {
  const gone = ({ dir }) => rmSync(join(dir, "check", "pass_to_pass"), { recursive: true });
  assert.notEqual(corpus(gone).status, 0);
  const bare = ({ dir }) => rmSync(join(dir, "check", "pass_to_pass", "wants-one.test.js"));
  assert.notEqual(corpus(bare).status, 0);
  const noFail = ({ dir }) => rmSync(join(dir, "check", "fail_to_pass"), { recursive: true });
  const r = corpus(noFail);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /fail_to_pass directory check\/fail_to_pass is missing/);
});

test("a manifest that breaks the schema fails the run", () => {
  assert.notEqual(corpus(({ manifest }) => delete manifest.pass_to_pass).status, 0);
  assert.notEqual(corpus(({ manifest }) => (manifest.start_state = 5)).status, 0);
});

test("the real corpus passes", () => {
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim().split("\n").filter((l) => l.startsWith("PASS")).length, 14);
});

test("prompts name neither the arms nor the hidden checks", () => {
  for (const kind of readdirSync(here).filter((f) => !f.includes("."))) {
    const text = readFileSync(join(here, kind, "prompt.md"), "utf8");
    assert.doesNotMatch(text, /blacksmith|claude|hidden|fail_to_pass|pass_to_pass|\.test\.js/i);
  }
});
