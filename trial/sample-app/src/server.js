import { createServer as createHttpServer } from "node:http";
import { createApp } from "./app.js";

export function createServer(db) {
  return createHttpServer(createApp(db));
}
