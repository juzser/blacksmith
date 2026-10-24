#!/usr/bin/env node
// Thin entry for the trial harness: parse argv, call the built module, print.
// Usage: node trial/harness/trial.mjs prepare|record|summarize [flags]; see trial/README.md.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const trialDir = resolve(here, "..");
const built = join(trialDir, "..", "factory", "orchestrator", "dist", "trial", "harness.js");

const flags = {
  task: { type: "string" },
  arm: { type: "string" },
  dir: { type: "string" },
  "cli-session": { type: "string" },
  "claude-config-dir": { type: "string" },
  interventions: { type: "string" },
  results: { type: "string" },
};

function need(values, ...names) {
  for (const name of names) if (!values[name]) throw new Error(`missing --${name}`);
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: flags, strict: true });
  let harness;
  try {
    harness = await import(pathToFileURL(built).href);
  } catch {
    throw new Error("the harness is not built; run `pnpm run build` first");
  }
  const deps = {
    spawn: harness.nodeSpawner,
    now: () => new Date(),
    tasksDir: join(trialDir, "tasks"),
    appDir: join(trialDir, "sample-app"),
  };
  if (verb === "prepare") {
    need(values, "task", "arm", "dir");
    process.stdout.write(harness.prepare({ task: values.task, arm: values.arm, dir: values.dir }, deps));
  } else if (verb === "record") {
    need(values, "task", "arm", "dir", "cli-session", "results");
    const rec = await harness.record(
      {
        task: values.task,
        arm: values.arm,
        dir: values.dir,
        cliSession: values["cli-session"],
        claudeConfigDir: values["claude-config-dir"] ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        ...(values.interventions === undefined ? {} : { interventions: Number(values.interventions) }),
        results: values.results,
      },
      deps,
    );
    process.stdout.write(`${JSON.stringify(rec)}\n`);
  } else if (verb === "summarize") {
    need(values, "results");
    process.stdout.write(harness.summarize({ results: values.results }));
  } else {
    throw new Error("usage: trial.mjs prepare|record|summarize [flags]");
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
