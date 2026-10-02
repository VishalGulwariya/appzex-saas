/**
 * Cross-platform wrapper around `next build`.
 *
 * `apps/web/next.config.ts` intentionally refuses to resolve an API rewrite target in a
 * production environment unless `API_INTERNAL_URL` is present and non-loopback. That guard is
 * correct for deployed environments and is left completely untouched.
 *
 * This wrapper only runs at build time and, when `API_INTERNAL_URL` is absent, supplies a
 * reserved non-resolvable placeholder so a local or CI compilation can complete on Windows
 * PowerShell and Linux without shell-specific environment syntax. When the build is running in
 * CI (`CI` is set), the wrapper instead fails the build, because a CI artifact baked with the
 * placeholder is unshippable.
 *
 * The placeholder uses the RFC 2606 reserved `.invalid` TLD, so it can never resolve to a real
 * host. A build produced this way therefore fails loudly at runtime instead of silently proxying
 * `/api/v1` to a loopback address. Such a build is not deployable: set `API_INTERNAL_URL` to the
 * real internal API origin before building for a deployment.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESERVED_BUILD_PLACEHOLDER = "https://api.internal.invalid";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = resolve(repoRoot, "apps/web");
const require = createRequire(import.meta.url);

function resolveNextBin() {
  for (const candidate of ["next/dist/bin/next", "apps/web/node_modules/next/dist/bin/next"]) {
    try {
      return require.resolve(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("Could not locate the Next.js CLI. Run npm install before building.");
}

const env = { ...process.env };
const configured = env.API_INTERNAL_URL?.trim();

if (!configured) {
  // The rewrite is evaluated and baked into the bundle at build time, so a CI build that falls
  // back to the placeholder would publish a deployment whose /api/v1 proxy can never resolve.
  // Fail loudly in CI instead of emitting an artifact that is broken by construction.
  if (env.CI) {
    console.error("[build:web] API_INTERNAL_URL is required in CI and was not set.");
    console.error("[build:web] Set it to the real non-loopback API origin in your CI/CD environment variables.");
    console.error("[build:web] Refusing to publish a build whose /api/v1 rewrite points at an unresolvable placeholder.");
    process.exit(1);
  }
  env.API_INTERNAL_URL = RESERVED_BUILD_PLACEHOLDER;
  console.warn(`[build:web] API_INTERNAL_URL is not set; compiling with the reserved placeholder ${RESERVED_BUILD_PLACEHOLDER}.`);
  console.warn("[build:web] This build is for local verification only and must not be deployed.");
  console.warn("[build:web] Set API_INTERNAL_URL to the real non-loopback API origin before building for deployment.");
}

const child = spawn(process.execPath, [resolveNextBin(), "build"], { cwd: webDir, env, stdio: "inherit", shell: false });

child.on("error", (error) => {
  console.error("[build:web] Failed to start next build", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[build:web] next build terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});