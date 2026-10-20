import { HttpError, readJson, sendJson, sendNoContent } from "../http.js";
import { createTag, deleteTag, listTags } from "../repos/tags.js";

export const tagRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/tags$/,
    handler: ({ db, res }) => sendJson(res, 200, listTags(db)),
  },
  {
    method: "POST",
    pattern: /^\/api\/tags$/,
    handler: async ({ db, req, res }) => {
      const { name } = await readJson(req);
      if (typeof name !== "string" || name.trim() === "") {
        throw new HttpError(400, "name is required");
      }
      try {
        sendJson(res, 201, createTag(db, name.trim()));
      } catch (err) {
        if (/UNIQUE/.test(err.message)) throw new HttpError(409, "tag already exists");
        throw err;
      }
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/tags\/(\d+)$/,
    handler: ({ db, res, params }) => {
      if (!deleteTag(db, Number(params[0]))) throw new HttpError(404, "tag not found");
      sendNoContent(res);
    },
  },
];
