import { openDatabase } from "./db.js";
import { migrate } from "./migrate.js";
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const db = openDatabase(process.env.DB_PATH ?? "sample-app.db");
const applied = migrate(db);
if (applied.length > 0) console.log(`applied migrations: ${applied.join(", ")}`);

createServer(db).listen(port, () => {
  console.log(`sample app listening on http://localhost:${port}`);
});
