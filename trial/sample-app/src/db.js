import { DatabaseSync } from "node:sqlite";

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
