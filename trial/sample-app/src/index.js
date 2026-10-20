import { openDatabase } from "./db.js";
import { migrate } from "./migrate.js";
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const db = openDatabase(process.env.DB_PATH ?? "sample-app.db");
migrate(db);

createServer(db).listen(port, () => {
  console.log(`sample app listening on http://localhost:${port}`);
});
