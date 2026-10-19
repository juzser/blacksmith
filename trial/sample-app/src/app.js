import { HttpError, sendJson } from "./http.js";
import { noteRoutes } from "./routes/notes.js";
import { tagRoutes } from "./routes/tags.js";
import { serveStatic } from "./static.js";

const routes = [...noteRoutes, ...tagRoutes];

// Builds the request listener for a database handle.
export function createApp(db) {
  return async function app(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        for (const route of routes) {
          const match = route.method === req.method && url.pathname.match(route.pattern);
          if (match) {
            await route.handler({ db, req, res, url, params: match.slice(1) });
            return;
          }
        }
        throw new HttpError(404, "no such route");
      }
      if (req.method === "GET" && (await serveStatic(url.pathname, res))) return;
      throw new HttpError(404, "not found");
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: "internal error" });
      }
    }
  };
}
