import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db.js";
import { listMigrationFiles, migrate } from "../src/migrate.js";

test("migrate applies every migration in numeric order", () => {
  const db = openDatabase(":memory:");
  const applied = migrate(db);
  const files = listMigrationFiles();
  assert.ok(files.length >= 2);
  assert.deepEqual(applied, files);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes("notes"));
  assert.ok(tables.includes("tags"));
});

test("migrate is idempotent", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  assert.deepEqual(migrate(db), []);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get();
  assert.equal(rows.n, listMigrationFiles().length);
});
