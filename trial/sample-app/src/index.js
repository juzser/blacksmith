import { openDatabase } from "./db.js";
import { migrate } from "./migrate.js";
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const db = openDatabase(process.env.DB_PATH ?? "sample-app.db");
migrate(db);

const server = createServer(db);
server.listen(port, "127.0.0.1", () => {
  const { address, port: bound } = server.address();
  const host = address.includes(":") ? `[${address}]` : address;
  console.log(`sample app listening on http://${host}:${bound}`);
});
