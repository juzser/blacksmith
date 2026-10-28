export function listTags(db) {
  return db.prepare("SELECT id, name FROM tags ORDER BY name").all();
}

export function getTag(db, id) {
  return db.prepare("SELECT id, name FROM tags WHERE id = ?").get(id);
}

export function createTag(db, name) {
  const info = db.prepare("INSERT INTO tags (name) VALUES (?)").run(name);
  return getTag(db, Number(info.lastInsertRowid));
}

export function deleteTag(db, id) {
  return db.prepare("DELETE FROM tags WHERE id = ?").run(id).changes > 0;
}
