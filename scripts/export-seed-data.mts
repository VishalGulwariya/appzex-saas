import { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

// Prisma Client needs DATABASE_URL in the process environment. Load it explicitly rather than
// relying on Prisma's incidental dotenv behaviour, which varies with module resolution.
const envFile = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find(existsSync);
if (envFile) loadEnv({ path: envFile });
else throw new Error(`No .env found at ${resolve(process.cwd(), ".env")}; DATABASE_URL is required to export data.`);

const prisma = new PrismaClient();

/**
 * Tables deliberately excluded from the export.
 *
 * `_prisma_migrations` is owned by the target instance: importing local rows would overwrite the
 * cloud instance's migration bookkeeping and could make Prisma believe migrations are applied when
 * they are not.
 *
 * `sessions` holds hashed session-token records. They are per-deployment runtime credentials, not
 * fixtures; copying them would import bearer credentials from a developer machine into production.
 *
 * `support_sessions` and `platform_activity` are audit/runtime records produced by local test runs.
 * They are not seed fixtures and would misrepresent production history.
 */
const EXCLUDE = new Set(["_prisma_migrations", "sessions", "support_sessions", "platform_activity"]);

function escapeString(value: string): string {
  return (
    "'" +
    value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\0/g, "\\0")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\x1a/g, "\\Z") +
    "'"
  );
}

/** Prisma returns JS Date objects for DATETIME/TIMESTAMP columns; MySQL needs a literal. */
function formatDateTime(value: Date): string {
  const iso = value.toISOString(); // 2026-10-01T20:01:19.000Z
  return iso.slice(0, 10) + " " + iso.slice(11, 23).replace("T", " ");
}

function literal(value: unknown, dataType: string): string {
  if (value === null || value === undefined) return "NULL";
  const type = dataType.toLowerCase();
  // Check Date before the generic string path, otherwise Date#toString leaks into the SQL.
  if (value instanceof Date) return escapeString(formatDateTime(value));
  if (/^(date|timestamp|datetime|time|year)/.test(type) && typeof value === "string") return escapeString(value);
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|bit|bool)/.test(type)) {
    return String(value);
  }
  if (type === "json") return escapeString(JSON.stringify(value));
  if (/^(blob|binary|varbinary|tinyblob|mediumblob|longblob)/.test(type)) {
    return "X'" + Buffer.from(value as Buffer).toString("hex") + "'";
  }
  return escapeString(String(value));
}

const tables = (
  await prisma.$queryRawUnsafe(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
  )
) as Array<{ t: string }>;

const out: string[] = [
  "-- AppZex data-only export (no DDL, _prisma_migrations excluded)",
  "-- Generated via Prisma so it matches the schema exactly.",
  "-- Import AFTER `prisma migrate deploy` has created the schema.",
  "",
  "SET NAMES utf8mb4;",
  "SET FOREIGN_KEY_CHECKS = 0;",
  "",
];

let totalRows = 0;
const summary: string[] = [];

for (const { t } of tables) {
  if (EXCLUDE.has(t)) continue;

  const columns = (
    await prisma.$queryRawUnsafe(
      "SELECT COLUMN_NAME AS n, DATA_TYPE AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      t
    )
  ) as Array<{ n: string; d: string }>;

  if (columns.length === 0) continue;

  const colList = columns.map((c) => `\`${c.n}\``).join(", ");
  // Table name comes from information_schema and contains no backticks, so inlining is safe.
  // Prisma's MySQL/MariaDB raw queries do not support the `??` identifier placeholder.
  const quoted = "`" + t.replace(/`/g, "") + "`";
  const rows = (await prisma.$queryRawUnsafe("SELECT * FROM " + quoted)) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    summary.push(`${t}: 0 rows`);
    continue;
  }

  const tuples = rows.map((row) => {
    const values = columns.map((c) => literal(row[c.n], c.d));
    return "  (" + values.join(", ") + ")";
  });

  out.push(`-- ${t}: ${rows.length} row(s)`);
  // Chunked so no single INSERT exceeds max_allowed_packet on import.
  const CHUNK = 200;
  for (let i = 0; i < tuples.length; i += CHUNK) {
    out.push(`INSERT INTO \`${t}\` (${colList}) VALUES`);
    out.push(tuples.slice(i, i + CHUNK).join(",\n") + ";");
  }
  out.push("");

  totalRows += rows.length;
  summary.push(`${t}: ${rows.length} row(s)`);
}

out.push("SET FOREIGN_KEY_CHECKS = 1;", "");
out.push("-- total rows exported: " + totalRows, "");

await prisma.$disconnect();

const target = process.argv[2];
if (!target) throw new Error("usage: tsx scripts/export-seed-data.mts <output.sql>");
writeFileSync(target, out.join("\n"), "utf8");
console.log(summary.join("\n"));
console.log("TOTAL ROWS: " + totalRows);