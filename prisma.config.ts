import { defineConfig } from "prisma/config";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

// Prisma no longer loads `.env` implicitly once a config file is present, so load it here to
// keep `db:generate`, `db:migrate`, `db:deploy`, and `db:seed` behaving exactly as before.
// Local-only values are read from the ignored root `.env`; nothing is hardcoded here.
loadEnv({ path: resolve(import.meta.dirname, ".env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts"
  }
});