import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const load = (p) => import(pathToFileURL(join(process.cwd(), p)).href);

test("existing notes survive the new migration and start unpinned", async () => {
  const { openDatabase } = await load("src/db.js");
  const { migrate, listMigrationFiles } = await load("src/migrate.js");
  const { readFileSync } = await import("node:fs");
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY)");
  for (const name of listMigrationFiles().slice(0, 2)) {
    db.exec(readFileSync(join(process.cwd(), "migrations", name), "utf8"));
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
  }
  db.prepare("INSERT INTO notes (title) VALUES ('old')").run();
  assert.equal(migrate(db).length, listMigrationFiles().length - 2);
  assert.ok(listMigrationFiles().length >= 3);
  assert.equal(db.prepare("SELECT pinned FROM notes").get().pinned, 0);
});
