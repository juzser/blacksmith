import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// Migration files are named NNN_description.sql and applied in name order.
export function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

// Applies every migration not yet recorded; returns the names it applied.
export function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)");
  const done = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((r) => r.name),
  );
  const applied = [];
  for (const name of listMigrationFiles()) {
    if (done.has(name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    applied.push(name);
  }
  return applied;
}
