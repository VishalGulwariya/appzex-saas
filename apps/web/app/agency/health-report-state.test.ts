import { describe, expect, it } from "vitest";
import {
  GENERIC_FAILURE_MESSAGE,
  INVALID_RESPONSE_MESSAGE,
  PROVIDER_ADVISORY_BANNER,
  interpretHealthResponse,
  isHealthMetrics,
  isHealthReport,
  isHealthReportForProject
} from "./health-report-state";

const validReport = {
  advisory: true,
  generatedAt: "2026-10-01T00:00:00.000Z",
  metrics: { taskCompletionPercent: 50, totalTasks: 2, completedTasks: 1, overdueTasks: 1, openFeedback: 1, upcomingMilestones: 1 },
  report: { health: "NEEDS_ATTENTION", summary: "Review delayed work.", risks: [{ severity: "MEDIUM", title: "Overdue task", evidence: "One task is past due." }], recommendedActions: ["Review the due date."] }
};

describe("health report project association", () => {
  it("shows a report only for the project that requested it", () => {
    expect(isHealthReportForProject("project-a", "project-a")).toBe(true);
    expect(isHealthReportForProject("project-a", "project-b")).toBe(false);
    expect(isHealthReportForProject(null, "project-a")).toBe(false);
  });

  it("accepts a valid report payload", () => {
    expect(isHealthReport(validReport)).toBe(true);
  });

  it("rejects malformed nested report data", () => {
    expect(isHealthReport({ ...validReport, report: { ...validReport.report, risks: null } })).toBe(false);
    expect(isHealthReport({ ...validReport, metrics: { ...validReport.metrics, overdueTasks: "one" } })).toBe(false);
    expect(isHealthReport({ ...validReport, metrics: null })).toBe(false);
  });
});

describe("backend-calculated metrics", () => {
  it("accepts metrics the backend sent alongside a successful report", () => {
    expect(isHealthMetrics(validReport.metrics)).toBe(true);
  });

  it("rejects out-of-range or impossible metric combinations", () => {
    expect(isHealthMetrics({ ...validReport.metrics, taskCompletionPercent: 140 })).toBe(false);
    expect(isHealthMetrics({ ...validReport.metrics, completedTasks: 5, totalTasks: 2 })).toBe(false);
    expect(isHealthMetrics(null)).toBe(false);
  });
});

describe("successful provider response", () => {
  it("returns a ready outcome with authoritative metrics", () => {
    const outcome = interpretHealthResponse(200, validReport);
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") throw new Error("unreachable");
    expect(outcome.metrics).toEqual(validReport.metrics);
    expect(outcome.report.health).toBe("NEEDS_ATTENTION");
  });

  it("reports an invalid payload instead of throwing", () => {
    const outcome = interpretHealthResponse(200, { advisory: true, generatedAt: "not-a-date", metrics: null, report: { risks: null } });
    expect(outcome).toEqual({ kind: "failed", message: INVALID_RESPONSE_MESSAGE });
  });
});

describe("upstream provider quota and capacity failures", () => {
  for (const status of [429, 502, 503, 504]) {
    it(`keeps backend metrics and shows the advisory banner on HTTP ${status}`, () => {
      const outcome = interpretHealthResponse(status, {
        advisory: true,
        aiAvailable: false,
        metrics: validReport.metrics,
        error: { code: "AI_PROVIDER_QUOTA_EXCEEDED", message: "The AI provider could not produce a valid report. Try again." }
      });
      expect(outcome.kind).toBe("degraded");
      if (outcome.kind !== "degraded") throw new Error("unreachable");
      expect(outcome.metrics).toEqual(validReport.metrics);
      expect(outcome.banner).toBe(PROVIDER_ADVISORY_BANNER);
      expect(outcome.message).toBe("The AI provider could not produce a valid report. Try again.");
    });
  }

  it("still degrades safely when the body carries no metrics", () => {
    const outcome = interpretHealthResponse(429, { error: { code: "RATE_LIMIT_EXCEEDED", message: "Health report generation limit exceeded. Please try again later." } });
    expect(outcome.kind).toBe("degraded");
    if (outcome.kind !== "degraded") throw new Error("unreachable");
    expect(outcome.metrics).toBeNull();
    expect(outcome.message).toBe("Health report generation limit exceeded. Please try again later.");
  });

  it("never leaks an upstream detail or credential from an unexpected body", () => {
    const outcome = interpretHealthResponse(503, { error: { code: "AI_UNAVAILABLE", message: "The AI provider could not produce a valid report. Try again." }, debug: "synthetic upstream provider detail" });
    expect(outcome.kind).toBe("degraded");
    if (outcome.kind !== "degraded") throw new Error("unreachable");
    expect(JSON.stringify(outcome)).not.toContain("synthetic upstream provider detail");
    expect(outcome.message).not.toContain("Bearer ");
  });

  it("handles a null or non-JSON body without throwing", () => {
    expect(interpretHealthResponse(502, null)).toEqual({ kind: "degraded", metrics: null, message: GENERIC_FAILURE_MESSAGE, banner: PROVIDER_ADVISORY_BANNER });
    expect(interpretHealthResponse(503, "not-json")).toEqual({ kind: "degraded", metrics: null, message: GENERIC_FAILURE_MESSAGE, banner: PROVIDER_ADVISORY_BANNER });
  });
});

describe("authorization and validation failures", () => {
  it("surfaces a clear message without the provider-capacity banner", () => {
    const notFound = interpretHealthResponse(404, { error: { code: "NOT_FOUND", message: "Project not found" } });
    expect(notFound).toEqual({ kind: "failed", message: "Project not found" });
    const forbidden = interpretHealthResponse(403, { error: { code: "FORBIDDEN", message: "Your workspace role cannot perform this action" } });
    expect(forbidden).toEqual({ kind: "failed", message: "Your workspace role cannot perform this action" });
    const unauthenticated = interpretHealthResponse(401, null);
    expect(unauthenticated).toEqual({ kind: "failed", message: GENERIC_FAILURE_MESSAGE });
  });
});