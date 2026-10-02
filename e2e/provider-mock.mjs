import { createServer } from "node:http";

const port = Number(process.env.E2E_PROVIDER_PORT ?? 4400);
const modes = new Set(["valid", "hold", "error", "quota", "invalid"]);
let mode = "valid";
let requestCount = 0;
let lastMetadata = null;
let releaseHeldResponse;

function respond(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request, limit = 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error("body_limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const report = {
  health: "NEEDS_ATTENTION",
  summary: "Synthetic advisory for browser verification.",
  risks: [{ severity: "LOW", title: "Synthetic risk", evidence: "A synthetic task needs review." }],
  recommendedActions: ["Review the synthetic task."]
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/__health") {
    respond(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__control/state") {
    respond(response, 200, { requestCount, mode, lastMetadata });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__control/reset") {
    try {
      const body = await readJson(request, 4096);
      if (!modes.has(body.mode)) {
        respond(response, 400, { error: "unsupported_mode" });
        return;
      }
      releaseHeldResponse?.();
      releaseHeldResponse = undefined;
      mode = body.mode;
      requestCount = 0;
      lastMetadata = null;
      respond(response, 200, { reset: true });
    } catch {
      respond(response, 400, { error: "invalid_control_request" });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/__control/release") {
    releaseHeldResponse?.();
    releaseHeldResponse = undefined;
    respond(response, 200, { released: true });
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    respond(response, 404, { error: "unexpected_mock_request" });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    respond(response, 400, { error: "invalid_mock_request" });
    return;
  }

  requestCount += 1;
  const inputText = JSON.stringify(body.input ?? []);
  let userContext;
  try {
    const userMessage = body.input?.find((item) => item.role === "user")?.content;
    userContext = typeof userMessage === "string" ? JSON.parse(userMessage) : null;
  } catch {
    userContext = null;
  }
  lastMetadata = {
    method: request.method,
    path: url.pathname,
    authorizationPresent: typeof request.headers.authorization === "string" && request.headers.authorization.startsWith("Bearer "),
    modelPresent: typeof body.model === "string" && body.model.length > 0,
    strictSchema: body.text?.format?.type === "json_schema" && body.text.format.strict === true,
    schemaNamePresent: body.text?.format?.name === "project_health_report",
    storeFalse: body.store === false,
    projectSentinelPresent: typeof userContext?.project?.name === "string" && userContext.project.name.startsWith("E2E_PROJECT_10D_"),
    taskSentinelPresent: Array.isArray(userContext?.tasks) && userContext.tasks.some((task) => typeof task.title === "string" && task.title.startsWith("E2E_TASK_10D_")),
    memberTaskPresent: Array.isArray(userContext?.tasks) && userContext.tasks.some((task) => typeof task.title === "string" && task.title.endsWith("_MEMBER")),
    ownerTaskAbsent: !Array.isArray(userContext?.tasks) || !userContext.tasks.some((task) => typeof task.title === "string" && task.title.endsWith("_OWNER")),
    privateFileSentinelAbsent: !inputText.includes("PRIVATE_FILE_SENTINEL_10D"),
    privateMeetingSentinelAbsent: !inputText.includes("PRIVATE_MEETING_SENTINEL_10D")
  };

  if (mode === "hold") {
    await new Promise((resolve) => { releaseHeldResponse = resolve; });
  }
  if (mode === "error") {
    respond(response, 503, { error: { message: "synthetic upstream provider detail" } });
    return;
  }
  if (mode === "quota") {
    respond(response, 429, { error: { message: "synthetic upstream quota or billing detail", type: "quota_or_billing" } });
    return;
  }

  const output = mode === "invalid"
    ? { health: "NOT_A_VALID_HEALTH", summary: "Synthetic invalid response." }
    : report;
  respond(response, 200, {
    status: "completed",
    output: [{ content: [{ type: "output_text", text: JSON.stringify(output) }] }]
  });
});

server.listen(port, "127.0.0.1");
