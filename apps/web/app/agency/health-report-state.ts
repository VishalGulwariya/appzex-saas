export type HealthMetrics = {
  taskCompletionPercent: number;
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  openFeedback: number;
  upcomingMilestones: number;
};

export type HealthReport = {
  advisory: true;
  generatedAt: string;
  metrics: HealthMetrics;
  report: {
    health: "HEALTHY" | "NEEDS_ATTENTION" | "AT_RISK";
    summary: string;
    risks: Array<{ severity: "LOW" | "MEDIUM" | "HIGH"; title: string; evidence: string }>;
    recommendedActions: string[];
  };
};

/**
 * Shown whenever the upstream AI provider cannot produce a narrative (HTTP 429 quota/rate
 * limit, 503 unavailable, 504 timeout, 502 bad output). The backend-calculated metrics
 * remain authoritative and are always rendered alongside this banner.
 */
export const PROVIDER_ADVISORY_BANNER = "AI narrative summary temporarily unavailable due to provider capacity; backend metrics are authoritative.";
export const INVALID_RESPONSE_MESSAGE = "The health report response was invalid.";
export const GENERIC_FAILURE_MESSAGE = "The health report could not be generated.";

const PROVIDER_DEGRADED_STATUSES = new Set([429, 502, 503, 504]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isRisk(value: unknown): value is HealthReport["report"]["risks"][number] {
  return isRecord(value) &&
    (value.severity === "LOW" || value.severity === "MEDIUM" || value.severity === "HIGH") &&
    isNonEmptyString(value.title, 180) &&
    isNonEmptyString(value.evidence, 500);
}

export function isHealthMetrics(value: unknown): value is HealthMetrics {
  if (!isRecord(value)) return false;
  const { taskCompletionPercent, totalTasks, completedTasks, overdueTasks, openFeedback, upcomingMilestones } = value;
  const counts = [totalTasks, completedTasks, overdueTasks, openFeedback, upcomingMilestones];
  if (!Number.isInteger(taskCompletionPercent) || Number(taskCompletionPercent) < 0 || Number(taskCompletionPercent) > 100) return false;
  if (!counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) return false;
  return Number(completedTasks) <= Number(totalTasks) && Number(overdueTasks) <= Number(totalTasks);
}

export function isHealthReport(value: unknown): value is HealthReport {
  if (!isRecord(value) || value.advisory !== true || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) return false;
  if (!isRecord(value.report)) return false;
  if (!isHealthMetrics(value.metrics)) return false;

  return (value.report.health === "HEALTHY" || value.report.health === "NEEDS_ATTENTION" || value.report.health === "AT_RISK") &&
    isNonEmptyString(value.report.summary, 1200) &&
    Array.isArray(value.report.risks) && value.report.risks.length <= 8 && value.report.risks.every(isRisk) &&
    Array.isArray(value.report.recommendedActions) && value.report.recommendedActions.length <= 8 &&
    value.report.recommendedActions.every((action) => isNonEmptyString(action, 300));
}

export function isHealthReportForProject(reportProjectId: string | null, selectedProjectId: string): boolean {
  return reportProjectId === selectedProjectId;
}

export type HealthOutcome =
  | { kind: "ready"; metrics: HealthMetrics; report: HealthReport["report"]; generatedAt: string }
  | { kind: "degraded"; metrics: HealthMetrics | null; message: string; banner: string }
  | { kind: "failed"; message: string };

function errorMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && isRecord(body.error) && isNonEmptyString(body.error.message, 500)) return body.error.message;
  return fallback;
}

/**
 * Turns any health-report HTTP outcome into a renderable decision. Never throws, so an
 * upstream outage can never surface as an uncaught runtime error in the drawer.
 */
export function interpretHealthResponse(status: number, body: unknown): HealthOutcome {
  if (status >= 200 && status < 300) {
    if (!isHealthReport(body)) return { kind: "failed", message: INVALID_RESPONSE_MESSAGE };
    return { kind: "ready", metrics: body.metrics, report: body.report, generatedAt: body.generatedAt };
  }

  const metrics = isRecord(body) && isHealthMetrics(body.metrics) ? body.metrics : null;
  if (PROVIDER_DEGRADED_STATUSES.has(status)) {
    return { kind: "degraded", metrics, message: errorMessage(body, GENERIC_FAILURE_MESSAGE), banner: PROVIDER_ADVISORY_BANNER };
  }
  return { kind: "failed", message: errorMessage(body, GENERIC_FAILURE_MESSAGE) };
}