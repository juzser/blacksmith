import { HttpError, readJson, sendJson, sendNoContent } from "../http.js";
import { createNote, deleteNote, getNote, listNotes, updateNote } from "../repos/notes.js";

function validate(input) {
  if (typeof input.title !== "string" || input.title.trim() === "") {
    throw new HttpError(400, "title is required");
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new HttpError(400, "tags must be a list of tag ids");
  }
  return input;
}

export const noteRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/notes$/,
    handler: ({ db, res, url }) => {
      const tag = url.searchParams.get("tag");
      sendJson(res, 200, listNotes(db, { tagId: tag ? Number(tag) : undefined }));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/notes$/,
    handler: async ({ db, req, res }) => {
      const input = validate(await readJson(req));
      sendJson(res, 201, createNote(db, input));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/notes\/(\d+)$/,
    handler: ({ db, res, params }) => {
      const note = getNote(db, Number(params[0]));
      if (!note) throw new HttpError(404, "note not found");
      sendJson(res, 200, note);
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/notes\/(\d+)$/,
    handler: async ({ db, req, res, params }) => {
      const input = validate(await readJson(req));
      const note = updateNote(db, Number(params[0]), input);
      if (!note) throw new HttpError(404, "note not found");
      sendJson(res, 200, note);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/notes\/(\d+)$/,
    handler: ({ db, res, params }) => {
      if (!deleteNote(db, Number(params[0]))) throw new HttpError(404, "note not found");
      sendNoContent(res);
    },
  },
];
