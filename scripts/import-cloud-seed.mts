/**
 * Cloud seed importer.
 *
 * Exists because running this from a PowerShell one-liner is unsafe: `$executeRawUnsafe`,
 * backticks and `${...}` inside a double-quoted `-e` argument are parsed by PowerShell, not
 * passed to Node. Keeping the logic in a real file removes that entire class of error.
 *
 * Usage:
 *   $env:CLOUD_DATABASE_URL = 'mysql://user:pass@host:3306/db?sslmode=REQUIRED'
 *   npx tsx scripts/import-cloud-seed.mts --dry-run   # parse + validate, change nothing
 *   npx tsx scripts/import-cloud-seed.mts             # apply
 *
 * Must run AFTER `prisma migrate deploy`; the fixture file contains no DDL.
 */
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";

const FIXTURE_PATH =
  process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : "C:/Users/DELL/AppData/Local/Temp/kilo/seed_data.sql";

const dryRun = process.argv.includes("--dry-run");

// A literal placeholder such as cloud-host is the exact failure this guards against: it produces
// Prisma P1001 "Can't reach database server" instead of a clear configuration error.
function readConnectionUrl(): string {
  const url = (process.env.CLOUD_DATABASE_URL ?? process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    throw new Error(
      "No database URL found. Set CLOUD_DATABASE_URL (preferred) or DATABASE_URL before running this script."
    );
  }
  if (!/^mysql:\/\/[^@]+@[^/:]+(:\d+)?\/[^?]+/.test(url)) {
    throw new Error("Database URL is not a well-formed mysql:// URL. Check for unescaped angle brackets.");
  }
  if (/<[A-Za-z_]+>/.test(url)) {
    throw new Error(
      "Database URL still contains placeholder text (for example <USER> or <HOST>). Substitute the real values."
    );
  }
  return url;
}

/**
 * Split on semicolons that terminate statements, ignoring semicolons inside quoted literals.
 * A plain `split(";")` would corrupt any value containing a semicolon.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "\\") {
      current += ch + (sql[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "'") inString = !inString;
    if (ch === ";" && !inString) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements.filter((s) => s.length > 0 && !/^--[^\n]*$/.test(s.replace(/\n/g, "")));
}

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}

async function main(): Promise<void> {
  const connectionUrl = readConnectionUrl();
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `Fixture file not found at ${FIXTURE_PATH}. Regenerate it with: npx tsx scripts/export-seed-data.mts "${FIXTURE_PATH}"`
    );
  }

  const sql = readFileSync(FIXTURE_PATH, "utf8");
  const statements = splitStatements(stripComments(sql));
  const prisma = new PrismaClient({ datasourceUrl: connectionUrl });

  try {
    await prisma.$queryRawUnsafe("SELECT 1");

    if (dryRun) {
      // EXPLAIN parses each statement on a real server without executing it, so syntax and
      // identifier errors surface here while the database is left untouched.
      // SET statements cannot be EXPLAINed, so they are executed directly: they are session
      // scoped, change no data, and affect only this connection.
      let valid = 0;
      let executedSets = 0;
      const failures: string[] = [];
      for (const [index, statement] of statements.entries()) {
        const isSet = /^\s*SET\s/i.test(statement);
        try {
          if (isSet) {
            await prisma.$executeRawUnsafe(statement);
            executedSets++;
          } else {
            await prisma.$queryRawUnsafe("EXPLAIN " + statement);
          }
          valid++;
        } catch (error) {
          const detail = String((error as Error).message)
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 3)
            .join(" | ")
            .slice(0, 170);
          const head = statement.split("\n")[0]!.trim().slice(0, 70);
          failures.push(`  #${index + 1} [${isSet ? "SET" : "SQL"}] ${head} :: ${detail}`);
        }
      }
      console.log(`  statements parsed : ${statements.length}`);
      console.log(`  session SET (applied harmlessly) : ${executedSets}`);
      console.log(`  syntax valid      : ${valid}`);
      console.log(`  invalid           : ${failures.length}`);
      for (const f of failures.slice(0, 10)) console.log(f);
      console.log(failures.length === 0 ? "  RESULT            : dry run clean, no rows written" : "  RESULT            : see failures above");
      return;
    }

    let applied = 0;
    for (const [index, statement] of statements.entries()) {
      try {
        await prisma.$executeRawUnsafe(statement);
        applied++;
      } catch (error) {
        const code = (error as { meta?: { code?: string } }).meta?.code ?? "unknown";
        const head = statement.split("\n")[0]!.slice(0, 90);
        throw new Error(`Statement ${index + 1}/${statements.length} failed (${code}): ${head}\n${String((error as Error).message).split("\n")[0]}`);
      }
    }
    console.log(`  statements applied : ${applied}/${statements.length}`);
    await reportRecordCounts(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function reportRecordCounts(prisma: PrismaClient): Promise<void> {
  const tables = ["agencies", "users", "agency_members", "clients", "client_members", "projects", "milestones", "tasks"];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${table}\``)) as Array<{ n: number | bigint }>;
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  const migrations = (await prisma.$queryRawUnsafe(
    "SELECT COUNT(*) AS n FROM `_prisma_migrations` WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
  )) as Array<{ n: number | bigint }>;
  const roles = (await prisma.$queryRawUnsafe("SELECT DISTINCT globalRole AS r FROM users ORDER BY globalRole")) as Array<{ r: string }>;
  const memberRoles = (await prisma.$queryRawUnsafe("SELECT DISTINCT role AS r FROM agency_members ORDER BY role")) as Array<{ r: string }>;

  console.log("  --- post-import verification ---");
  for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(16)}: ${n}`);
  console.log(`  users.globalRole : ${roles.map((r) => r.r).join(", ")}`);
  console.log(`  agency_members.role : ${memberRoles.map((r) => r.r).join(", ")}`);
  console.log(`  migrations applied  : ${Number(migrations[0]?.n ?? 0)}`);

  const checks: Array<[string, boolean]> = [
    ["agencies = 5", counts["agencies"] === 5],
    ["users = 13", counts["users"] === 13],
    ["only USER/SUPER_ADMIN globalRole", roles.every((r) => r.r === "USER" || r.r === "SUPER_ADMIN")],
    ["OWNER/ADMIN/MEMBER present", ["OWNER", "ADMIN", "MEMBER"].every((r) => memberRoles.some((m) => m.r === r))],
    ["4 migrations applied", Number(migrations[0]?.n ?? 0) === 4]
  ];
  let ok = true;
  for (const [label, pass] of checks) {
    if (!pass) ok = false;
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${label}`);
  }
  console.log(ok ? "  RESULT            : import verified" : "  RESULT            : verification failed");
}

main().catch((error: unknown) => {
  console.error("Import failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});