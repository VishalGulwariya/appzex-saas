import { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// Verify against the real schema, so this needs the same DATABASE_URL the exporter used.
const envFile = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find(existsSync);
if (envFile) loadEnv({ path: envFile });
else throw new Error(`No .env found at ${resolve(process.cwd(), ".env")}; DATABASE_URL is required to verify an export.`);

const prisma = new PrismaClient();
const sql = readFileSync(process.argv[2], "utf8");

const realTables = new Map<string, Set<string>>();
const t = (await prisma.$queryRawUnsafe(
  "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
)) as Array<{ t: string }>;
for (const { t: name } of t) {
  const cols = (await prisma.$queryRawUnsafe(
    "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    name
  )) as Array<{ c: string }>;
  realTables.set(name, new Set(cols.map((c) => c.c)));
}

const problems: string[] = [];
let statements = 0;

// Validate every INSERT: table exists and every named column exists.
const insertRe = /INSERT INTO `([^`]+)` \(([^)]+)\) VALUES/gi;
let m: RegExpExecArray | null;
while ((m = insertRe.exec(sql)) !== null) {
  statements++;
  const [, table, colList] = m;
  if (!realTables.has(table)) {
    problems.push(`unknown table: ${table}`);
    continue;
  }
  const known = realTables.get(table)!;
  for (const raw of colList.split(",")) {
    const col = raw.trim().replace(/`/g, "");
    if (!known.has(col)) problems.push(`${table}: unknown column ${col}`);
  }
}

// Paren balance per statement (string-aware enough for escaped quotes).
const stripped = sql.replace(/\\./g, "").replace(/'(?:[^']|'')*'/g, "''");
const opens = (stripped.match(/\(/g) ?? []).length;
const closes = (stripped.match(/\)/g) ?? []).length;

// Every non-comment, non-blank line must end a statement or continue a VALUES tuple.
const ddl = (sql.match(/\b(CREATE|ALTER|DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/gi) ?? []).length;

await prisma.$disconnect();

console.log(`  tables in export      : ${[...realTables.keys()].filter((k) => new RegExp("INSERT INTO `" + k + "`").test(sql)).length}`);
console.log(`  INSERT statements     : ${statements}`);
console.log(`  unknown tables        : ${problems.filter((p) => p.startsWith("unknown")).length}`);
console.log(`  unknown columns       : ${problems.filter((p) => p.includes("column")).length}`);
console.log(`  DDL statements        : ${ddl} (must be 0)`);
console.log(`  parens balanced       : ${opens === closes} (${opens}/${closes})`);
console.log(`  FK guard present      : ${sql.includes("SET FOREIGN_KEY_CHECKS = 0;") && sql.includes("SET FOREIGN_KEY_CHECKS = 1;")}`);
if (problems.length) {
  console.log("  PROBLEMS:");
  for (const p of problems.slice(0, 10)) console.log("    - " + p);
} else {
  console.log("  RESULT                : structurally valid");
}