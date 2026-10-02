# AppZex — Submission Note

Companion to `README.md`. This note records the architectural decisions, the isolation and
progress mechanics, the upstream AI constraints, and the production deployment contract.

## 1. Status

| Area | State |
| --- | --- |
| API unit + integration tests | 63/63 passing |
| Web unit tests | 18/18 passing |
| Browser E2E (Playwright) | 13/13 passing |
| Typecheck / lint | Clean (`--max-warnings=0`) |
| Production build (`npm run build`) | Passes, both workspaces |
| Phase 10C-R | **Partial — blocked on upstream OpenAI billing, not on code** |

## 2. Architectural decisions

**Monorepo, two independently deployable apps.** `apps/api` is Express 5 + Prisma + MySQL and
owns all authorization. `apps/web` is Next.js 15 App Router and contains no authorization logic
of its own. This split is deliberate: the browser is never a trust boundary, so every tenant
decision is made server-side in one auditable place.

**Authorization is centralized and fails closed.** All actions are declared in
`apps/api/src/policies/authorization.ts` rather than being re-derived per route. A missing or
malformed context throws rather than defaulting to a permissive branch, so an unhandled route
degrades to denial instead of to data exposure.

**Tenant scope is derived, never passed in.** See §3. Repository signatures do not accept an
`agencyId` scope argument, so a caller cannot widen its own scope by supplying a different id.

**Progress is never stored.** See §4. A typed-in percentage would be able to disagree with the
task list it supposedly summarizes.

**The web build is the only place a production API origin is baked.** The `/api/v1` rewrite is
declared once, in `apps/web/next.config.ts:31`, and resolved at **build** time. `vercel.json`
deliberately does *not* redeclare the rewrite — a second definition would produce conflicting
rewrite chains for the same source pattern.

**The production API-origin guard is a security control, not a DX obstacle.** In production the
resolver rejects a missing value, a loopback host (`localhost`, `*.localhost`, `::1`, `0.0.0.0`,
`127.0.0.0/8`), a non-HTTP(S) scheme, embedded credentials, and any path/query/fragment. Local
compilation without the variable is handled *outside* `next.config.ts` by `scripts/build-web.mjs`,
which injects the RFC 2606 reserved placeholder `https://api.internal.invalid` — unresolvable by
construction. The guard itself is unmodified, and the wrapper **fails the build** when `CI` is
set, because a CI artifact baked with the placeholder would be broken when published.

## 3. Multi-tenant isolation mechanics

`apps/api/src/repositories/tenant-scope.ts` is the single derivation point. `tenantScope(context)`
returns a discriminated `TenantScope` and throws `AuthorizationError` when it cannot prove a
legitimate context:

- **Agency** — keyed by `agencyId` from the server-created request context. `assignedOnly` is set
  for `MEMBER`, and `managedOnly` for `PROJECT_MANAGER`, so narrowing happens once here and is
  inherited by every query.
- **Client** — keyed by `agencyId` *and* `clientId`, so a client can never read across companies
  within the same agency.
- **Support** — a Super Admin receives no agency scope from role alone. The resolver requires
  `portal === "super-admin"` together with a `supportSessionId` and `supportAgencyId`, so
  cross-agency access always exists as a recorded, time-bounded session rather than as a role
  property.

Filters are applied **at query time**, not after fetching. This is the load-bearing detail: an
unauthorized file or project must return *no row at all*, otherwise row counts and error shapes
would still leak the existence of other tenants' data.

The support target is reloaded from the database on each request, so it cannot be pinned to stale
or arbitrary request-supplied context.

## 4. Dynamic progress formula

Progress is always computed from task data in
`apps/api/src/repositories/project-progress.ts`. There is no progress column on the project
model and no code path that accepts a manual percentage.

```
progress = totalTasks > 0 ? round(completedTasks / totalTasks * 100) : 0
```

- Only `TaskStatus.DONE` counts as complete (`isCompletedTaskStatus`).
- Zero tasks yields `0`, never a division by zero and never `100`.
- `deriveProjectProgressFromCounts` is the aggregate equivalent used where only counts are
  available; it floors, clamps `completed` into `[0, total]`, and returns `0` for non-finite
  input. The clamp is deliberate: a bad aggregate must not be able to produce `> 100`.
- `Math.round` keeps the value an integer, so the UI never has to reconcile `40.0000000001%`.

Seeded expectations: Agency A reads 40% (2 of 5 tasks done), Agency B reads 50% (1 of 2). Both are
asserted in tests, so a change to the formula fails the suite rather than silently altering a demo
figure.

## 5. Upstream AI quota limits and degraded behaviour

The project health report calls the OpenAI Responses API with Structured Outputs and re-validates
the response with Zod. Upstream failures are normalized so no provider error body, credential, or
internal detail reaches the browser:

| Upstream condition | API response |
| --- | --- |
| HTTP 429 (rate limit, quota, or billing) | `429 AI_PROVIDER_QUOTA_EXCEEDED` |
| HTTP 503 (provider unavailable) | `503 AI_PROVIDER_UNAVAILABLE` |
| Other provider / invalid-output failure | `502 AI_UNAVAILABLE` |
| Timeout (`AI_TIMEOUT_MS`, default 20 s) | `504 AI_TIMEOUT` |
| Provider not configured | `503 AI_NOT_CONFIGURED` |
| Tenant report limit reached | `429 RATE_LIMIT_EXCEEDED` with `Retry-After` |

**Every degraded response still carries the backend-calculated `metrics` and `aiAvailable: false`.**
The narrative is advisory; the metrics are authoritative. This is why a billing outage degrades a
feature instead of removing it.

The client issues exactly one request per explicit click — no polling, no retry, no backoff loop —
so an upstream outage cannot escalate into a request storm. Response parsing is a total function
in `apps/web/app/agency/health-report-state.ts`, so a malformed, empty, or non-JSON body yields a
readable message rather than an uncaught error or a stuck spinner.

**Known upstream limitation.** Phase 10C-R is complete in code and remains partial only because
the upstream OpenAI account is billing-blocked, so a live provider request has not been executed.
Provider behaviour is verified against a loopback mock in `NODE_ENV=test`; production provider
routing stays pinned to OpenAI and the mock URL is rejected outside test. A live smoke test is the
only outstanding item, and it is a credential/billing problem, not an implementation gap.

## 6. Production deployment contract

The web build consumes `API_INTERNAL_URL` at **build** time; the API container consumes
`DATABASE_URL` and friends at **run** time. Conflating the two is the most likely deployment error.

**`@appzex/api` — `Dockerfile` at the repository root** (Render / Railway / Fly / ECS / `docker run`):

| Variable | When | Notes |
| --- | --- | --- |
| `DATABASE_URL` | runtime | MySQL URL. Inside Docker this must be the **service hostname**, not `127.0.0.1`, which is the container itself. |
| `SESSION_SECRET` | runtime | ≥ 32 characters. The example placeholder value is explicitly rejected. |
| `WEB_ORIGIN` | runtime | **Required** in production, must be `https://`, non-loopback origin. Used for CORS and cookies. |
| `NODE_ENV` | runtime | Must be `production`. |
| `COOKIE_SECURE` | runtime | Defaults to `true` when `NODE_ENV=production`. |
| `API_PORT` | runtime | Defaults to `4000`; the image exposes `4000`. |
| `FILE_STORAGE_PATH` | runtime | Mount a persistent volume; keep it outside any static web root. |
| `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` | runtime, optional | Omit all three to disable AI; the API then returns `AI_NOT_CONFIGURED`. |
| `SEED_PASSWORD` | never | Development seed only. Do not set it in production. |

The container entrypoint runs `prisma migrate deploy` before starting the server. That command is
forward-only: it applies committed migrations and never drops or resets data.

**`@appzex/web` — `vercel.json` at the repository root** (set the Vercel project Root Directory
to the repository root, not `apps/web`, so npm workspaces install correctly):

| Variable | When | Notes |
| --- | --- | --- |
| `API_INTERNAL_URL` | **build** (and runtime) | Must be the real non-loopback API origin. Because the rewrite is baked at build time, setting it only at runtime will not fix an already-built bundle. |

Do not add a `rewrites` block to `vercel.json`; the rewrite is owned by `apps/web/next.config.ts`.

`CI` is set by Vercel, so a build without `API_INTERNAL_URL` fails fast via `scripts/build-web.mjs`
instead of publishing a bundle whose proxy can never resolve.

## 7. Known limitations

- Password reset and invitation delivery are not implemented.
- Rate-limit counters are in-process, so limits are per-instance and not shared across replicas.
- AI narrative summaries are unverified against the live provider (§5).
- File storage is local disk; multi-instance deployments need shared object storage.
- Browser E2E covers health reporting and support mode; other portals are covered by API
  integration tests only.
