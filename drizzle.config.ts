import { defineConfig } from 'drizzle-kit';

// Generates factory/orchestrator/drizzle/*.sql from db/schema.ts. Applied at
// runtime by db/projector.ts via drizzle-orm's better-sqlite3 migrator — the
// same migration set is the D1 port's migration set later (docs/standards/
// stack.md: "one schema, both targets").
export default defineConfig({
  dialect: 'sqlite',
  schema: 'factory/orchestrator/src/db/schema.ts',
  out: 'factory/orchestrator/drizzle',
});
