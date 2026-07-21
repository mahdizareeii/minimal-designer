import { createHash } from "node:crypto";

export interface BackupRetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

export const BACKUP_RETENTION_POLICY: Readonly<BackupRetentionPolicy> = Object.freeze({
  daily: 7,
  weekly: 4,
  monthly: 12,
});

export const BACKUP_SCHEDULE_GRACE_MS = 6 * 60 * 60 * 1_000;
export const BACKUP_SCHEDULE_STALL_MS = 20 * 60 * 1_000;

export type ManagedRetentionClass = keyof typeof BACKUP_RETENTION_POLICY;
export type BackupRetentionClass = "manual" | ManagedRetentionClass;

export interface BackupScheduleWindow {
  dueAt: string;
  nextDueAt: string;
}

export type BackupScheduleAttemptStatus = "running" | "created" | "already_completed" | "failed";

export interface BackupScheduleAttempt {
  runId: string;
  status: BackupScheduleAttemptStatus;
  dueAt: string;
  nextDueAt: string;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  retryable: boolean | null;
}

export interface BackupScheduleSupervisionAlert {
  code:
    | "BACKUP_WINDOW_DUE"
    | "BACKUP_WINDOW_OVERDUE"
    | "SCHEDULE_RUN_FAILED"
    | "SCHEDULE_RUN_STALLED"
    | "RETENTION_PRUNE_REQUIRED"
    | "BACKUP_RECORDS_REQUIRE_REVIEW";
  severity: "warning" | "critical";
  message: string;
}

export interface BackupScheduleSupervision {
  status: "disabled" | "healthy" | "warning" | "critical";
  checkedAt: string;
  dueAt: string | null;
  nextDueAt: string | null;
  graceEndsAt: string | null;
  currentWindowCovered: boolean;
  latestAttempt: BackupScheduleAttempt | null;
  retention: {
    candidateCount: number;
    candidateBytes: number;
    protectedCount: number;
    planHash: string;
  };
  alerts: BackupScheduleSupervisionAlert[];
}

export interface BackupScheduleSupervisionInput {
  enabled: boolean;
  cronExpression: string;
  at: Date;
  currentWindowCovered: boolean;
  latestAttempt: BackupScheduleAttempt | null;
  retentionCandidateCount: number;
  retentionCandidateBytes: number;
  retentionProtectedCount: number;
  retentionPlanHash: string;
}

export interface RetentionRecord {
  id: string;
  filename: string;
  bundleSha256: string | null;
  status: "creating" | "valid" | "invalid" | "restored";
  createdAt: string;
  verifiedAt: string | null;
  completedAt: string | null;
  sizeBytes: number | null;
  retentionClass: BackupRetentionClass;
}

export interface RetentionPlanRecord extends RetentionRecord {
  effectiveCompletedAt: string;
}

export interface BackupRetentionPlan {
  policy: Readonly<BackupRetentionPolicy>;
  retained: RetentionPlanRecord[];
  candidates: RetentionPlanRecord[];
  manualExemptCount: number;
  protectedCount: number;
  totalCandidateBytes: number;
  planHash: string;
}

function requireValidDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid ${field} timestamp.`);
  return parsed;
}

export function parseDailyBackupCron(expression: string): { minute: number; hour: number } {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression.trim());
  if (!match) throw new Error("Backup schedules support one daily UTC time in the form 'minute hour * * *'.");
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59 || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("Backup schedule hour or minute is outside the valid UTC range.");
  }
  return { minute, hour };
}

export function backupScheduleWindow(expression: string, at: Date): BackupScheduleWindow {
  if (!Number.isFinite(at.getTime())) throw new Error("The schedule evaluation time is invalid.");
  const { minute, hour } = parseDailyBackupCron(expression);
  const due = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hour, minute));
  if (due.getTime() > at.getTime()) due.setUTCDate(due.getUTCDate() - 1);
  const next = new Date(due.getTime());
  next.setUTCDate(next.getUTCDate() + 1);
  return { dueAt: due.toISOString(), nextDueAt: next.toISOString() };
}

export function evaluateBackupScheduleSupervision(
  input: Readonly<BackupScheduleSupervisionInput>,
): BackupScheduleSupervision {
  if (!Number.isFinite(input.at.getTime())) throw new Error("The schedule supervision time is invalid.");
  if (!Number.isSafeInteger(input.retentionCandidateCount) || input.retentionCandidateCount < 0
    || !Number.isSafeInteger(input.retentionCandidateBytes) || input.retentionCandidateBytes < 0
    || !Number.isSafeInteger(input.retentionProtectedCount) || input.retentionProtectedCount < 0
    || !/^[a-f0-9]{64}$/.test(input.retentionPlanHash)) {
    throw new Error("The schedule supervision retention summary is invalid.");
  }

  const checkedAt = input.at.toISOString();
  const window = input.enabled ? backupScheduleWindow(input.cronExpression, input.at) : null;
  const graceEndsAt = window === null
    ? null
    : new Date(new Date(window.dueAt).getTime() + BACKUP_SCHEDULE_GRACE_MS).toISOString();
  const alerts: BackupScheduleSupervisionAlert[] = [];
  const currentAttempt = window !== null && input.latestAttempt?.dueAt === window.dueAt
    ? input.latestAttempt
    : null;

  if (currentAttempt?.status === "failed") {
    alerts.push({
      code: "SCHEDULE_RUN_FAILED",
      severity: "critical",
      message: `The latest scheduled backup attempt failed with ${currentAttempt.errorCode ?? "INTERNAL_ERROR"}.`,
    });
  } else if (currentAttempt?.status === "running"
    && input.at.getTime() - new Date(currentAttempt.startedAt).getTime() >= BACKUP_SCHEDULE_STALL_MS) {
    alerts.push({
      code: "SCHEDULE_RUN_STALLED",
      severity: "critical",
      message: "The scheduled backup attempt has no terminal result after the bounded execution window.",
    });
  }

  if (window !== null && !input.currentWindowCovered) {
    if (graceEndsAt !== null && checkedAt > graceEndsAt) {
      alerts.push({
        code: "BACKUP_WINDOW_OVERDUE",
        severity: "critical",
        message: "No verified managed backup covers the current schedule window after its grace period.",
      });
    } else {
      alerts.push({
        code: "BACKUP_WINDOW_DUE",
        severity: "warning",
        message: "The current scheduled backup window is due and does not yet have a verified backup.",
      });
    }
  }
  if (input.retentionCandidateCount > 0) {
    alerts.push({
      code: "RETENTION_PRUNE_REQUIRED",
      severity: "warning",
      message: `${input.retentionCandidateCount} verified scheduled backup(s) require a reviewed retention prune.`,
    });
  }
  if (input.retentionProtectedCount > 0) {
    alerts.push({
      code: "BACKUP_RECORDS_REQUIRE_REVIEW",
      severity: "warning",
      message: `${input.retentionProtectedCount} incomplete or invalid backup record(s) require operator review.`,
    });
  }

  const status = alerts.some((alert) => alert.severity === "critical")
    ? "critical"
    : alerts.length > 0
      ? "warning"
      : input.enabled
        ? "healthy"
        : "disabled";
  return {
    status,
    checkedAt,
    dueAt: window?.dueAt ?? null,
    nextDueAt: window?.nextDueAt ?? null,
    graceEndsAt,
    currentWindowCovered: input.enabled && input.currentWindowCovered,
    latestAttempt: input.latestAttempt,
    retention: {
      candidateCount: input.retentionCandidateCount,
      candidateBytes: input.retentionCandidateBytes,
      protectedCount: input.retentionProtectedCount,
      planHash: input.retentionPlanHash,
    },
    alerts,
  };
}

function isoWeekBounds(at: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - day + 1);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function calendarRetentionBounds(at: Date): {
  monthStart: string;
  monthEnd: string;
  weekStart: string;
  weekEnd: string;
} {
  if (!Number.isFinite(at.getTime())) throw new Error("The retention classification time is invalid.");
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const week = isoWeekBounds(at);
  return {
    monthStart: monthStart.toISOString(),
    monthEnd: monthEnd.toISOString(),
    weekStart: week.start,
    weekEnd: week.end,
  };
}

function normalizedPlanRecord(record: RetentionRecord): RetentionPlanRecord | null {
  if (record.retentionClass === "manual") return null;
  if (record.status !== "valid" && record.status !== "restored") return null;
  if (!record.bundleSha256 || !/^[a-f0-9]{64}$/.test(record.bundleSha256)) return null;
  if (record.sizeBytes === null || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) return null;
  const effectiveCompletedAt = record.completedAt ?? record.verifiedAt;
  if (!effectiveCompletedAt) return null;
  requireValidDate(record.createdAt, "backup creation");
  requireValidDate(effectiveCompletedAt, "backup completion");
  return { ...record, effectiveCompletedAt };
}

function compareNewest(left: RetentionPlanRecord, right: RetentionPlanRecord): number {
  return right.effectiveCompletedAt.localeCompare(left.effectiveCompletedAt) || right.id.localeCompare(left.id);
}

function validatedRetentionPolicy(policy: Readonly<BackupRetentionPolicy>): Readonly<BackupRetentionPolicy> {
  for (const retentionClass of ["daily", "weekly", "monthly"] as const) {
    if (!Number.isSafeInteger(policy[retentionClass]) || policy[retentionClass] < 1) {
      throw new Error(`Backup ${retentionClass} retention must be a positive safe integer.`);
    }
  }
  return Object.freeze({ ...policy });
}

function planHash(
  retained: readonly RetentionPlanRecord[],
  candidates: readonly RetentionPlanRecord[],
  policy: Readonly<BackupRetentionPolicy>,
): string {
  const project = (record: RetentionPlanRecord) => ({
    id: record.id,
    filename: record.filename,
    bundleSha256: record.bundleSha256,
    status: record.status,
    sizeBytes: record.sizeBytes,
    retentionClass: record.retentionClass,
    effectiveCompletedAt: record.effectiveCompletedAt,
  });
  return createHash("sha256").update(JSON.stringify({
    format: "formaspec-backup-retention-plan",
    version: 1,
    policy,
    retained: retained.map(project),
    candidates: candidates.map(project),
  })).digest("hex");
}

export function buildBackupRetentionPlan(
  records: readonly RetentionRecord[],
  requestedPolicy: Readonly<BackupRetentionPolicy> = BACKUP_RETENTION_POLICY,
): BackupRetentionPlan {
  const policy = validatedRetentionPolicy(requestedPolicy);
  const manualExemptCount = records.filter((record) => record.retentionClass === "manual").length;
  const eligible = records.map(normalizedPlanRecord).filter((record): record is RetentionPlanRecord => record !== null);
  const protectedCount = records.length - manualExemptCount - eligible.length;
  const retained: RetentionPlanRecord[] = [];
  const candidates: RetentionPlanRecord[] = [];

  for (const retentionClass of ["daily", "weekly", "monthly"] as const) {
    const classRecords = eligible.filter((record) => record.retentionClass === retentionClass).sort(compareNewest);
    const keep = policy[retentionClass];
    retained.push(...classRecords.slice(0, keep));
    candidates.push(...classRecords.slice(keep));
  }

  retained.sort(compareNewest);
  candidates.sort(compareNewest);
  return {
    policy,
    retained,
    candidates,
    manualExemptCount,
    protectedCount,
    totalCandidateBytes: candidates.reduce((total, record) => total + (record.sizeBytes ?? 0), 0),
    planHash: planHash(retained, candidates, policy),
  };
}
