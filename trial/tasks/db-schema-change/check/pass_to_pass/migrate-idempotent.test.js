import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const load = (p) => import(pathToFileURL(join(process.cwd(), p)).href);

test("migrate is idempotent and records every migration file once", async () => {
  const { openDatabase } = await load("src/db.js");
  const { migrate, listMigrationFiles } = await load("src/migrate.js");
  const db = openDatabase(":memory:");
  assert.deepEqual(migrate(db), listMigrationFiles());
  assert.deepEqual(migrate(db), []);
  const rows = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all();
  assert.deepEqual(rows.map((r) => r.name), listMigrationFiles());
  db.prepare("INSERT INTO notes (title) VALUES ('kept')").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 1);
});
