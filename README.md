# AppZex

AppZex is a multi-tenant project management platform for agencies. The repository includes authentication and tenant context, agency/client project workflows, feedback, meetings, private file handling, and advisory project-health reporting.

## Architecture

```text
Browser ? Next.js App Router (apps/web) ? Express REST API (apps/api) ? Prisma ? MySQL
```

The web app owns pages and browser interactions. The API owns request validation, authentication, session handling, authorization context, business rules, and database access. Prisma uses its MySQL connector for the tenant-scoped data model in `prisma/schema.prisma`; versioned migrations are in `prisma/migrations`. The production database engine and version have not been selected.

## Stack

- Next.js App Router, React, TypeScript, Tailwind CSS
- Node.js, Express, TypeScript, Zod
- Prisma ORM with the MySQL connector
- bcrypt password hashing and opaque database-backed sessions

## Local development

1. Install Node.js 20 or later and a local database supported by the configured Prisma MySQL connector. The Phase 9 local database was MariaDB 10.4.32; this does not establish production MySQL/MariaDB compatibility.
2. Copy `.env.example` to `.env`. For API runtime, set `NODE_ENV`, `DATABASE_URL`, `SESSION_SECRET` to a random value of at least 32 characters, and `WEB_ORIGIN`. For local development the example uses localhost. Set `SEED_PASSWORD` only if you intend to run the development seed; it defaults to `password123`.
3. Install dependencies with `npm install`.
4. Generate Prisma Client and apply migrations: `npm run db:generate` then `npm run db:migrate`.
5. Load development accounts and fixtures with `npm run db:seed`.
6. Run both apps with `npm run dev`.

The web app runs at http://localhost:3000 and proxies `/api/v1` to the Express API at http://localhost:4000. The API health endpoint is `GET /api/v1/health`.

`npm run build` requires `API_INTERNAL_URL` in the environment of the web build process, and production additionally requires a non-loopback HTTPS origin. This is a deliberate guard, not a build failure to work around.

## Runtime configuration

The API requires an explicit `NODE_ENV` (`development`, `test`, or `production`), `DATABASE_URL`, and `SESSION_SECRET` of at least 32 characters. In development and tests, `WEB_ORIGIN` defaults to `http://localhost:3000`; production requires an explicit HTTPS origin that does not use a loopback host. `DATABASE_URL` is validated as a database URL without echoing its contents in validation errors; production engine/version remains undecided. `API_PORT`, `SESSION_TTL_DAYS`, `COOKIE_SECURE`, `COOKIE_SAME_SITE`, `AUTH_LOGIN_RATE_LIMIT` (sign-in attempts per 15-minute window per process instance, default 10), `AI_REPORT_RATE_LIMIT` (AI health reports per tenant per 10-minute window, default 5), and `FILE_STORAGE_PATH` have runtime defaults documented in `.env.example`. Production requires secure cookies; the API rejects an explicit insecure cookie setting.

`AI_PROVIDER` is optional. Leave it unset to run without AI reports. Setting it to `openai` requires `AI_API_KEY` and `AI_MODEL`; provide the key through deployment secret management, never commit it. Choose a model supported and enabled for the project from current OpenAI documentation; AppZex intentionally does not guess or silently replace a model. `AI_TIMEOUT_MS` defaults to 20000 milliseconds and controls the provider timeout. The API does not require AI credentials to start when AI is disabled.

For local AI setup, create an API key through the OpenAI account/API dashboard and place it only in ignored local `.env`. Set `AI_PROVIDER=openai`, `AI_API_KEY`, and an explicitly selected supported `AI_MODEL`; keep `AI_TIMEOUT_MS=20000`. Run `npm run ai:preflight` to validate configuration only; it makes no network request and never prints the key. A successful configuration preflight does not prove provider authentication, model access, or connectivity. Run a separately designated live synthetic health-report verification only after that gate passes.

`API_INTERNAL_URL` is read from the Next.js process environment when `next.config.ts` is evaluated. Production requires an explicit non-loopback HTTP(S) origin; the development fallback is `http://localhost:4000`. It is not browser-facing. Supply it to the web build/configuration process; the root `.env` is not loaded by this config before evaluation. Build the web output for the environment whose API rewrite target it will use.

`SEED_PASSWORD` is used only by the development seed script, which refuses to run when `NODE_ENV=production` or against a non-local database, and which defaults to the documented local evaluation password `password123`. Do not include it in production API runtime configuration and do not run the development seed in production. `.env` is ignored by Git; `.env.example` contains placeholders only.

Production database engine/version is not yet selected. Do not infer production compatibility from the local MariaDB environment or the Prisma `mysql` provider. Production deployment must use a separately provisioned database and explicitly chosen migration/rollback procedure. `npm run db:deploy` applies committed migrations; `npm run db:migrate` is for development. Apply migrations as a deployment operation before starting application instances that require the new schema. Rollback procedure is undefined and requires an explicit operational decision.

## Authentication and tenant context

`GET /api/v1/auth/csrf` issues a signed double-submit token. `POST /api/v1/auth/login` validates and normalizes email, checks the bcrypt password hash, and creates a random opaque session token in an HttpOnly cookie. Only its SHA-256 hash is stored in the database. Sessions expire after the configured `SESSION_TTL_DAYS` and can be revoked at logout. State-changing `/api/v1` requests require the signed CSRF cookie and matching `X-CSRF-Token` header. Login attempts are rate limited per process instance.

`GET /api/v1/auth/me` returns the server-resolved role and active portal context. Users with multiple active agency/client memberships must select a workspace. `POST /api/v1/auth/context` accepts a context identifier only after verifying the signed-in user's membership and active agency status. Agency, client, and Super Admin middleware are separate; client memberships are not agency memberships. Agency/client context middleware rechecks membership and blocks suspended agencies on each request.

Cookies are HttpOnly for sessions, use `SameSite=Lax` by default, and default to `Secure` in production. For a cross-site web/API deployment, configure `COOKIE_SAME_SITE=none` and `COOKIE_SECURE=true`, use HTTPS, and set `WEB_ORIGIN` to the exact frontend origin. `SESSION_SECRET` is server-only.

## Database model and tenant boundaries

The schema includes users and global roles, agencies and memberships, agency settings, clients and client memberships, projects, milestones, tasks and comments, meetings, feedback and comments, files, activity logs, support sessions, and login sessions. Composite foreign keys tie projects to clients in the same agency, tasks to projects and milestones in the same agency, task assignees and authors to agency memberships, and attached files to tenant-scoped records. Services must still scope every query to authenticated membership; relational constraints complement authorization and do not replace it.

### Derived project progress

Assignment section 07 forbids typed-in progress. There is no `progress` column on `projects`, and no endpoint accepts one: the create schema is `.strict()`, so a `progress` key is rejected with `400 VALIDATION_ERROR`, and there is no project update route. Every response that includes progress derives it in `apps/api/src/repositories/project-progress.ts`:

```text
progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0
```

Changing a task status therefore changes project progress immediately and consistently across the agency dashboard, agency project list and detail, and every client-portal surface.

## Super Admin support mode and tenant suspension

A Super Admin opens an audited support session (`POST /api/v1/admin/agencies/:id/support-sessions`, or the equivalent `POST /api/v1/auth/support-session`) naming the target agency, a reason, and start time. While it is active, both the agency workspace and the Super Admin portal display a prominent banner reading "Viewing [Agency Name] in Super Admin Support Mode" with a clearly labelled "Exit Support Mode" button. Every agency-scoped request made under support mode is written to the audit trail. Ending the session removes the banner and immediately restores the HTTP 403 boundary.

Support-mode audit records are stored in `platform_activity`, not `activity_logs`. This is deliberate and schema-enforced: `activity_logs.actorId` is a composite foreign key to `agency_members(agencyId, userId)`, and a Super Admin is never an agency member of the agency they support, because doing so would grant tenant membership. Recording support access in `platform_activity` keeps the actor a plain `users` reference while still capturing actor, target agency, event type, entity, human-readable summary, structured metadata, and timestamp. A test asserts both that the audit rows exist for entry, per-action access, and exit, and that the Super Admin holds zero agency memberships.

Agency status is enforced at login and on every authenticated request. `POST /api/v1/auth/login` refuses to issue a session to a user whose only agency is suspended, returning `403 AGENCY_SUSPENDED` with the agency name. Agency and client context middleware re-check agency status per request, so an existing session loses access as soon as the agency is suspended, with `403 AGENCY_SUSPENDED`.

## Development accounts

`npm run db:seed` (root script: `prisma db seed`) is idempotent and non-destructive: it only upserts, and it refuses to run when `NODE_ENV=production` or when `DATABASE_URL` does not point at the local `appzex` database. All seeded accounts share one bcrypt-hashed local password taken from `SEED_PASSWORD`, which defaults to the documented evaluation value `password123`. Never reuse that password outside local evaluation or publish it, and do not configure `SEED_PASSWORD` as a production runtime requirement.

Evaluation dataset created by the seed:

| Role | Email | Tenant | Notes |
| --- | --- | --- | --- |
| Super Admin | `superadmin@appzex.local` | platform | Platform portal, audited Support Mode |
| Agency Admin | `admin@agencya.local` | Apex Digital Marketing (ACTIVE) | Full admin actions in Agency A |
| Team Member | `dev@agencya.local` | Apex Digital Marketing | Assignment-scoped visibility only |
| Client User | `client@companya.local` | ClientCorp A | Client portal scoped to its own company |
| Agency Admin | `admin@agencyb.local` | Nexus Software Agency (ACTIVE) | Isolation target for Agency A |
| Team Member | `dev@agencyb.local` | Nexus Software Agency | Assignment-scoped visibility inside Agency B |
| Client User | `client@companyb.local` | ClientCorp B | Separate client portal |
| Agency Admin | `admin@suspended.local` | Stalled Creative (SUSPENDED) | Login is rejected with HTTP 403 |

Agency A contains one active project with three milestones and five tasks (two completed, two in progress, one overdue), a client-visible meeting note, an open feedback item, a shared project file, and an activity log entry. Agency B contains a distinct project with its own milestones, tasks, meeting, feedback, file, and activity log so cross-tenant access can be demonstrated. Project progress is always derived: Agency A reads 40% (2 of 5 tasks done) and Agency B reads 50% (1 of 2), and neither percentage exists as a stored value.

The seed also maintains a developer sample dataset (`admin@appzex.test`, `owner@northstar.test`, `client@northstar.test`, `owner@lighthouse.test`, `client@lighthouse.test`) that the project health-report tenant-isolation integration tests rely on.

## Scripts

- `npm run dev` starts the web app and API.
- `npm run build` builds the API and web app.
- `npm run lint` runs ESLint for both workspaces.
- `npm run typecheck` checks TypeScript for both workspaces.
- `npm test` runs workspace tests, including mounted health-report route coverage for authentication, CSRF, cross-tenant access and provider failure handling, and a mounted evaluation-seed suite covering suspension lockout, tenant isolation, support mode, and derived progress.
- `npm run db:generate` generates Prisma Client.
- `npm run db:migrate` applies development migrations.
- `npm run db:deploy` applies committed migrations.
- `npm run db:seed` loads the idempotent evaluation and developer sample fixtures and users.

## Production build and deployment

`npm run build` builds the API and the web app. The web build calls `scripts/build-web.mjs`, which
supplies the reserved non-loopback placeholder `https://api.internal.invalid` when
`API_INTERNAL_URL` is unset so a local build succeeds; the production guard in
`apps/web/next.config.ts` is untouched and still rejects a missing or loopback origin. Because
`/api/v1` rewrites are resolved at build time, the build fails fast when `CI` is set and
`API_INTERNAL_URL` is missing, so an unshippable bundle cannot be published.

- `Dockerfile` builds the `@appzex/api` image for Docker-based hosting (Render, Railway, Fly, ECS).
- `vercel.json` configures `@appzex/web`; the `/api/v1` rewrite stays owned by `next.config.ts`.

Required environment variables per platform, and the build-time versus run-time distinction for
`API_INTERNAL_URL`, are documented in [SUBMISSION_NOTE.md](SUBMISSION_NOTE.md) section 6.

### Deploying the web app to Vercel

**Repository:** https://github.com/VishalGulwariya/appzex-saas

1. Sign in at https://vercel.com and choose **Add New → Project**, then import
   `VishalGulwariya/appzex-saas`. Vercel will detect Next.js; confirm **Framework Preset: Next.js**.
2. **Leave Root Directory at the repository root.** Do not set it to `apps/web`. This repository
   is an npm workspaces monorepo and its only lockfile is `package-lock.json` at the root. With the
   root directory set to `apps/web`, Vercel finds no lockfile, installs unpinned dependency
   versions, and cannot run the `build:web` wrapper that enforces the production origin guard.
3. Do not override Build or Output settings in the dashboard. `vercel.json` already sets:
   - Install Command `npm ci`
   - Build Command `npm run build:web`
   - Output Directory `apps/web/.next`
4. Add the environment variable below, then deploy. The first deploy fails by design if it is
   missing, which prevents publishing a bundle whose `/api/v1` proxy points at an unresolvable
   host. Read the failure message rather than removing the guard.

**Environment variables to paste into the Vercel dashboard** (Project → Settings → Environment
Variables) — this is the complete list:

| Variable | Value | Scope | Required |
| --- | --- | --- | --- |
| `API_INTERNAL_URL` | `https://api.your-api-host.com` | **Build + Runtime** | Yes |

`API_INTERNAL_URL` must be an absolute, non-loopback HTTP(S) origin with no trailing path — for
example `https://api.example.com`, not `http://localhost:4000` and not
`https://api.example.com/api`. The loopback guard in `apps/web/next.config.ts` is enforced at build
time and rejects `localhost`, `127.x.x.x`, `::1`, and `0.0.0.0`.

Two properties worth knowing before you deploy:

- **It is a build-time variable.** The `/api/v1` rewrite is resolved while the bundle is built, so
  setting it only at runtime has no effect. Change it, then redeploy to rebuild.
- **It must not be `NEXT_PUBLIC_`-prefixed.** It names an internal service; a `NEXT_PUBLIC_` prefix
  would inline it into the client bundle and expose it to every browser.

The web tier needs no other variables. `DATABASE_URL`, `SESSION_SECRET`, and `AI_API_KEY` belong to
the API service and must never be added to the Vercel project. `apps/web/.env.example` documents the
web variables; the API variables are in the root `.env.example`.

**Deliverables — live URLs**

| Deliverable | URL |
| --- | --- |
| Repository | https://github.com/VishalGulwariya/appzex-saas |
| Web app (Vercel) | _pending deployment — paste the production URL here_ |
| API | _pending deployment — paste the production URL here_ |

## Browser E2E tests

Browser tests run the real Next.js UI and Express API with a loopback-only mock for the upstream Responses API. They never use OpenAI credentials or send project data externally. Install Chromium with `npm run test:e2e:install`, then run `npm run test:e2e` from the repository root. Node.js 20 or later is required.

The suite requires the existing local `appzex` MySQL-connector test database, configured through local `.env`, with the committed schema already applied, and requires `npm run db:seed` to have been run at least once because `e2e/support-mode.spec.mjs` signs in with the seeded evaluation accounts. It verifies the database host and database name before creating anything; it does not migrate or seed. Each run creates uniquely named synthetic agencies, users, projects, tasks, milestones, feedback, and private-data sentinels, runs with one worker, and cleans up only the recorded fixture IDs during Playwright teardown. The API receives a generated ephemeral mock credential and a loopback provider URL accepted only in `NODE_ENV=test`; production provider routing remains fixed to OpenAI. Playwright traces and screenshots are retained only on failure under ignored `test-results/`.

## Remaining scope and limitations

Agency and client dashboards, tenant-scoped project and task workflows, feedback and meeting APIs, private local file storage, and advisory project-health reports are implemented as MVP workflows. Password reset and invitation delivery, shared rate-limit storage for multi-instance deployments, production AI provider credentials, and full integration/security coverage remain future work. Production deployment configuration is now provided: the root `Dockerfile` builds the API image for Docker-based hosts, and `vercel.json` configures the web app; the required environment variables and the build-time versus run-time distinction for `API_INTERNAL_URL` are documented in [SUBMISSION_NOTE.md](SUBMISSION_NOTE.md) section 6. Local Prisma connectivity and migration state have been verified; health-report route authentication, tenant isolation, provider quota/capacity failure handling, and side-effect behavior are covered by API integration tests and browser E2E tests. Browser E2E coverage exists for project health reporting and support mode; other portals are covered by API integration tests only. Provider tests use a mock, so a live OpenAI request and production provider data handling have not been verified.

## Authorization policies and data scope

Authorization actions are centralized in `apps/api/src/policies/authorization.ts`. Policies fail closed for missing context, separate platform-wide Super Admin operations from tenant actions, deny clients agency administration and internal notes, and restrict client feedback/files to their own company and shared files. Member task/project reads are assignment-scoped; the policy supports optional member creation only when a route explicitly enables it.

`apps/api/src/repositories` derives `agencyId`, client scope, and assignment filters from the server-created request context. Repository calls do not accept an agency identifier as a scope parameter. Project, task, and file reads are constrained at query time; unauthorized files return no result. Super Admin agency access requires an explicit support session, which records actor, target agency, reason, start time, and end time. The support target is reloaded from the database on each request and cannot be selected from arbitrary request context.


## Communication and files

Agency users can schedule project meetings, choose whether meeting notes are client-visible, review client feedback, reply to clients, and update feedback status. Client views include only client-visible meetings, activity, and feedback.

Project files are stored privately under `FILE_STORAGE_PATH` (default `./private-uploads`) with generated storage keys. Uploads are limited to 10 MB and PDF, PNG, JPEG, TXT, and CSV; downloads re-check tenant, assignment, and sharing permissions. Keep the storage directory outside static/public web roots. Client downloads require the file visibility to be `CLIENT_SHARED`.



## AI project health reports

Set `AI_PROVIDER=openai`, `AI_API_KEY`, and `AI_MODEL` to enable the agency project health report. The AI settings are optional, so the API starts without them and returns a clear `AI_NOT_CONFIGURED` response until configured. `AI_TIMEOUT_MS` defaults to 20 seconds and can be set from 1,000 to 60,000 milliseconds. The integration calls the OpenAI Responses API with Structured Outputs and validates the response again with Zod. See [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Only an authenticated agency workspace or explicit audited Super Admin support session can request a report. The project is checked through the existing tenant and assignment scoped repository before related tasks, milestones, feedback, or activity are queried. Member task visibility is preserved. Backend code calculates task completion, overdue tasks, open feedback, and milestones due in the next 14 days. Inputs are length and count limited; user entered descriptions and feedback are treated as untrusted data. Private file contents and meeting notes are not sent to the provider. The request sets `store: false`; provider processing remains subject to the configured provider's data handling terms.

Reports are advisory for agency members to review. The AI endpoint does not update project or task statuses, create activity, or send client communications.

### Upstream AI failure handling

Provider outages, quota rejections, and billing exhaustion are normalized and never leak upstream detail, credentials, or provider error bodies to the browser:

| Upstream condition | API response |
| --- | --- |
| HTTP 429 (rate limit or quota/billing) | `429 AI_PROVIDER_QUOTA_EXCEEDED` |
| HTTP 503 (provider unavailable) | `503 AI_PROVIDER_UNAVAILABLE` |
| Other provider or invalid-output failure | `502 AI_UNAVAILABLE` |
| Provider timeout | `504 AI_TIMEOUT` |
| AI not configured | `503 AI_NOT_CONFIGURED` |
| Tenant report limit reached | `429 RATE_LIMIT_EXCEEDED` (with `Retry-After`) |

Every degraded response still carries the backend-calculated `metrics` and `aiAvailable: false`. The Project Health drawer renders those authoritative metrics (task counts, completion percentage, overdue items, open feedback, upcoming milestones) next to the advisory banner "AI narrative summary temporarily unavailable due to provider capacity; backend metrics are authoritative." Response parsing is a total function in `apps/web/app/agency/health-report-state.ts`, so a malformed, empty, or non-JSON body surfaces a readable message instead of an uncaught runtime error or a stuck spinner. The drawer issues exactly one request per explicit click: there is no polling, automatic retry, or backoff loop, so an upstream outage cannot turn into a request storm.


