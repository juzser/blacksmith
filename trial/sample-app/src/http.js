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

export function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}
