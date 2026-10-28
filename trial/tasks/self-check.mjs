#!/usr/bin/env node
// Corpus self-check: for every task, prepare the start state on a temp copy of the sample app
// and confirm that each fail_to_pass test fails there and each pass_to_pass test passes there.
// Usage: node self-check.mjs [--tasks-dir DIR] [--app DIR]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? resolve(argv[argv.indexOf(name) + 1]) : dflt);
const tasksDir = opt("--tasks-dir", here);
const appDir = opt("--app", join(here, "..", "sample-app"));

// The small subset of JSON Schema the manifest schema uses.
function validate(value, schema, path = "manifest") {
  const types = [].concat(schema.type ?? []);
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if ("const" in schema && value !== schema.const) return [`${path} must be ${schema.const}`];
  if (types.length && !types.includes(kind)) return [`${path} must be ${types.join(" or ")}`];
  const errors = [];
  if (kind === "string" && value.length < (schema.minLength ?? 0)) errors.push(`${path} is empty`);
  if (kind === "array") {
    if (value.length < (schema.minItems ?? 0)) errors.push(`${path} needs more items`);
    value.forEach((v, i) => errors.push(...validate(v, schema.items ?? {}, `${path}[${i}]`)));
  }
  if (kind === "object") {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      if (key in props) errors.push(...validate(v, props[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

// A parent test runner marks its children as nested; drop that so each file runs on its own.
const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
const schema = JSON.parse(readFileSync(join(here, "manifest.schema.json"), "utf8"));
let failures = 0;
const report = (ok, task, group, file, note) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${task} ${group} ${file}${note ? ` - ${note}` : ""}`);
};

function prepare(taskPath, manifest) {
  const copy = mkdtempSync(join(tmpdir(), "trial-task-"));
  cpSync(appDir, copy, { recursive: true, filter: (src) => !src.includes("node_modules") });
  if (manifest.start_state !== null) {
    const patch = resolve(taskPath, manifest.start_state);
    const res = spawnSync("git", ["apply", patch], { cwd: copy, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`start state does not apply: ${res.stderr.trim()}`);
  }
  return copy;
}

for (const task of readdirSync(tasksDir).sort()) {
  const taskPath = join(tasksDir, task);
  if (!existsSync(join(taskPath, "manifest.json"))) continue;
  let copy;
  try {
    const manifest = JSON.parse(readFileSync(join(taskPath, "manifest.json"), "utf8"));
    const errors = validate(manifest, schema);
    if (errors.length) throw new Error(errors.join("; "));
    const dirs = [
      ["fail_to_pass", manifest.fail_to_pass, false],
      ["pass_to_pass", manifest.pass_to_pass, true],
    ].map(([group, rel, expected]) => {
      const dir = resolve(taskPath, rel);
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort() : [];
      if (files.length === 0) throw new Error(`${group} directory ${rel} is missing or has no test file`);
      return { group, dir, files, expected };
    });
    copy = prepare(taskPath, manifest);
    for (const { group, dir, files, expected } of dirs) {
      for (const file of files) {
        const res = spawnSync("node", ["--test", join(dir, file)], { cwd: copy, encoding: "utf8", env });
        const passed = res.status === 0;
        report(passed === expected, task, group, file, passed ? "passes on the start state" : "fails on the start state");
      }
    }
  } catch (err) {
    report(false, task, "setup", "-", err.message);
  } finally {
    if (copy) rmSync(copy, { recursive: true, force: true });
  }
}
process.exit(failures === 0 ? 0 : 1);
