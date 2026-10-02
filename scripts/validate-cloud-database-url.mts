/**
 * Pre-flight validation for a cloud MySQL connection URI.
 *
 * Catches the two failures that cost a provisioning run before any Prisma command is issued:
 *   P1013 "invalid port number in database URL" - placeholder port text such as YOUR_PORT
 *   P1001 "Can't reach database server"          - placeholder or non-resolving hostname
 *
 * Both are opaque at the Prisma layer. Validating shape and reachability here produces an
 * actionable message instead.
 *
 * Usage:
 *   $env:CLOUD_DATABASE_URL = 'mysql://user:pass@host:3306/db?sslmode=REQUIRED'
 *   npx tsx scripts/validate-cloud-database-url.mts
 *   npx tsx scripts/validate-cloud-database-url.mts --allow-loopback   # local testing only
 */
import { lookup } from "node:dns/promises";
import { connect } from "node:net";

const raw = (process.env.CLOUD_DATABASE_URL ?? process.env.DATABASE_URL ?? "").trim();
const allowLoopback = process.argv.includes("--allow-loopback");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const PLACEHOLDER_TOKENS = [
  "YOUR_", "your_", "your-", "<", ">", "{{", "}}", "changeme", "CHANGE_ME",
  "placeholder", "example.com", "yourdomain", "your-domain", "xxx", "XXX", "TODO", "REPLACE_ME"
];
const KNOWN_BAD_HOSTS = ["cloud-host", "your-host", "yourhost", "db-host", "host", "example"];

interface Failure { rule: string; detail: string }
const failures: Failure[] = [];
const pass: string[] = [];

function fail(rule: string, detail: string): void {
  failures.push({ rule, detail });
}
function ok(rule: string, detail: string): void {
  pass.push(`${rule}: ${detail}`);
}

async function main(): Promise<void> {
  if (!raw) {
    fail("URL present", "CLOUD_DATABASE_URL is not set. Export it before running this check.");
    return;
  }
  ok("URL present", `${raw.length} chars (value not echoed)`);

  // 1. Reject template markers anywhere in the string, before parsing.
  const markers = PLACEHOLDER_TOKENS.filter((t) => raw.includes(t));
  if (markers.length > 0) {
    fail("No template markers", `contains placeholder token(s): ${markers.join(", ")}`);
  } else {
    ok("No template markers", "none of <>, YOUR_*, changeme, example.com present");
  }

  // 2. Protocol.
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    fail("URL parses", "could not be parsed as a URL");
  }

  if (parsed) {
    if (parsed.protocol === "mysql:") ok("Protocol", "mysql://");
    else fail("Protocol", `expected mysql:// but found ${parsed.protocol}//`);

    // 3. Hostname.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) {
      fail("Hostname", "missing");
    } else if (KNOWN_BAD_HOSTS.includes(host)) {
      fail("Hostname", `"${host}" is a literal placeholder, not a real host`);
    } else if (LOOPBACK.has(host) && !allowLoopback) {
      fail("Hostname", `${host} is loopback; a cloud URI must not point at localhost`);
    } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
      if (allowLoopback) ok("Hostname", `${host} (loopback permitted by --allow-loopback)`);
      else fail("Hostname", "raw IP address supplied; use the hostname a provider gives you");
    } else if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
      fail("Hostname", `"${host}" is not a resolvable domain`);
    } else {
      ok("Hostname", `${host} looks like a domain`);
    }

    // 4. Port must be numeric and in range.
    const portText = parsed.port;
    if (!portText) {
      fail("Port", "no port supplied; MySQL defaults to 3306, cloud providers often use 19563/49210");
    } else if (!/^\d+$/.test(portText)) {
      fail("Port", `"${portText}" is not numeric - this is what causes Prisma P1013`);
    } else if (Number(portText) < 1 || Number(portText) > 65535) {
      fail("Port", `${portText} is outside 1-65535`);
    } else {
      ok("Port", portText);
    }

    // 5. Credentials present and free of template text.
    const user = decodeURIComponent(parsed.username || "");
    if (!user) fail("Credentials", "no username in the URI");
    else if (/YOUR|your|changeme/i.test(user)) fail("Credentials", "username looks like a placeholder");
    else ok("Credentials", "username present, not a placeholder");

    if (!parsed.password) fail("Credentials", "no password in the URI");
    else if (/YOUR|your|changeme|password123/i.test(parsed.password)) fail("Credentials", "password looks like a placeholder or the local seed default");
    else ok("Credentials", "password present, not a known placeholder");

    // 6. Database name.
    const db = parsed.pathname.replace(/^\//, "");
    if (!db || db.includes("<")) fail("Database", "missing or placeholder database name");
    else ok("Database", db);

    // 7. SSL parameter must use Prisma's spelling.
    const sslMode = parsed.searchParams.get("sslmode");
    const sslAccept = parsed.searchParams.get("sslaccept");
    const wrong = parsed.searchParams.get("ssl-mode");
    if (wrong) {
      fail("SSL parameter", `found ?ssl-mode=${wrong}; Prisma expects ?sslmode= (that spelling is MySQL CLI syntax)`);
    } else if (sslMode) {
      ok("SSL parameter", `sslmode=${sslMode}`);
    } else if (sslAccept) {
      ok("SSL parameter", `sslaccept=${sslAccept}`);
    } else {
      fail("SSL parameter", "no ?sslmode= or ?sslaccept= present; managed MySQL requires TLS");
    }

    // 8. Reachability: DNS then TCP. This is what turns P1001 into a clear answer.
    if (host && !LOOPBACK.has(host) && !failures.some((f) => f.rule === "Hostname")) {
      try {
        const resolved = await lookup(host);
        ok("DNS", `${host} -> ${resolved.address}`);
        try {
          const reachable = await new Promise<boolean>((done) => {
            const socket = connect({ host: resolved.address, port: Number(portText || 3306) });
            const timer = setTimeout(() => { socket.destroy(); done(false); }, 5000);
            socket.once("connect", () => { clearTimeout(timer); socket.destroy(); done(true); });
            socket.once("error", () => { clearTimeout(timer); done(false); });
          });
          if (reachable) ok("TCP", `port ${portText || 3306} accepted a connection`);
          else fail("TCP", `port ${portText || 3306} did not accept a connection within 5s`);
        } catch (error) {
          fail("TCP", String((error as Error).message).slice(0, 100));
        }
      } catch {
        fail("DNS", `${host} did not resolve - this is what causes Prisma P1001`);
      }
    }
  }
}

main().then(() => {
  for (const line of pass) console.log("  [PASS] " + line);
  for (const f of failures) console.log(`  [FAIL] ${f.rule} - ${f.detail}`);
  console.log("");
  console.log(failures.length === 0 ? "  RESULT: URI is well-formed and reachable. Safe to migrate." : `  RESULT: ${failures.length} problem(s). Do not run prisma migrate yet.`);
  process.exit(failures.length === 0 ? 0 : 1);
});