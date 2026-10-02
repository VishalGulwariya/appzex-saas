import { describe, expect, it } from "vitest";
import { TaskStatus } from "@prisma/client";
import { deriveProjectProgress, deriveProjectProgressFromCounts } from "./project-progress";

describe("derived project progress", () => {
  it("matches the assignment formula for every task shape", () => {
    expect(deriveProjectProgress([])).toBe(0);
    expect(deriveProjectProgress([{ status: TaskStatus.TODO }])).toBe(0);
    expect(deriveProjectProgress([{ status: TaskStatus.DONE }, { status: TaskStatus.TODO }])).toBe(50);
    expect(deriveProjectProgress([
      { status: TaskStatus.DONE },
      { status: TaskStatus.DONE },
      { status: TaskStatus.IN_PROGRESS },
      { status: TaskStatus.IN_PROGRESS },
      { status: TaskStatus.TODO }
    ])).toBe(40);
    expect(deriveProjectProgress([{ status: TaskStatus.DONE }, { status: TaskStatus.DONE }, { status: TaskStatus.DONE }])).toBe(100);
  });

  it("rounds to the nearest whole percent like the backend count formula", () => {
    expect(deriveProjectProgress([{ status: TaskStatus.DONE }, { status: TaskStatus.TODO }, { status: TaskStatus.TODO }])).toBe(33);
    expect(deriveProjectProgressFromCounts(3, 1)).toBe(33);
    expect(deriveProjectProgressFromCounts(7, 2)).toBe(29);
  });

  it("returns zero when there are no tasks", () => {
    expect(deriveProjectProgressFromCounts(0, 0)).toBe(0);
  });

  it("clamps impossible counts instead of emitting out-of-range percentages", () => {
    expect(deriveProjectProgressFromCounts(2, 5)).toBe(100);
    expect(deriveProjectProgressFromCounts(-4, 1)).toBe(0);
    expect(deriveProjectProgressFromCounts(Number.NaN, 1)).toBe(0);
  });
});