const { spawnSync } = require("node:child_process");
const { dirname, resolve } = require("node:path");
const { config } = require("dotenv");

config({ path: resolve(__dirname, "../../../.env") });
const prismaPackage = require.resolve("prisma/package.json");
const prismaCli = resolve(dirname(prismaPackage), "build/index.js");
const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  console.error(`Could not start Prisma CLI: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}