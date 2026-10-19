function tagsFor(db, noteId) {
  return db
    .prepare(
      `SELECT t.id, t.name FROM tags t
       JOIN note_tags nt ON nt.tag_id = t.id
       WHERE nt.note_id = ? ORDER BY t.name`,
    )
    .all(noteId);
}

function withTags(db, row) {
  return row ? { ...row, tags: tagsFor(db, row.id) } : undefined;
}

function setTags(db, noteId, tagIds) {
  db.prepare("DELETE FROM note_tags WHERE note_id = ?").run(noteId);
  const insert = db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)");
  for (const tagId of tagIds) insert.run(noteId, tagId);
}

export function listNotes(db, { tagId } = {}) {
  const rows = tagId
    ? db
        .prepare(
          `SELECT n.* FROM notes n
           JOIN note_tags nt ON nt.note_id = n.id
           WHERE nt.tag_id = ? ORDER BY n.id`,
        )
        .all(tagId)
    : db.prepare("SELECT * FROM notes ORDER BY id").all();
  return rows.map((row) => withTags(db, row));
}

export function getNote(db, id) {
  return withTags(db, db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
}

export function createNote(db, { title, body = "", tags = [] }) {
  const info = db.prepare("INSERT INTO notes (title, body) VALUES (?, ?)").run(title, body);
  const id = Number(info.lastInsertRowid);
  setTags(db, id, tags);
  return getNote(db, id);
}

export function updateNote(db, id, { title, body = "", tags }) {
  const info = db
    .prepare("UPDATE notes SET title = ?, body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(title, body, id);
  if (info.changes === 0) return undefined;
  if (tags) setTags(db, id, tags);
  return getNote(db, id);
}

export function deleteNote(db, id) {
  return db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes > 0;
}
