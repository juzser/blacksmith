// Small helpers shared by the route modules.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export const sendNoContent = (res) => res.writeHead(204).end();

export const MAX_BODY_BYTES = 1024 * 1024;

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Past the cap, keep draining so the 413 can be delivered, but stop buffering.
    if (size > MAX_BODY_BYTES) chunks.length = 0;
    else chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body is too large");
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}
