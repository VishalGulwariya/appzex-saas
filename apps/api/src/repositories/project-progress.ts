import { TaskStatus } from "@prisma/client";

export type ProgressTask = { status: TaskStatus | string };

export function isCompletedTaskStatus(status: TaskStatus | string): boolean {
  return status === TaskStatus.DONE;
}

/**
 * Project progress is always derived from task data. Assignment section 07 forbids
 * typed-in progress values, so no code path accepts or persists a manual percentage.
 */
export function deriveProjectProgress(tasks: ProgressTask[]): number {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => isCompletedTaskStatus(task.status)).length;
  return totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
}

export function deriveProjectProgressFromCounts(totalTasks: number, completedTasks: number): number {
  if (!Number.isFinite(totalTasks) || !Number.isFinite(completedTasks)) return 0;
  const total = Math.max(0, Math.floor(totalTasks));
  const completed = Math.min(Math.max(0, Math.floor(completedTasks)), total);
  return total > 0 ? Math.round((completed / total) * 100) : 0;
}