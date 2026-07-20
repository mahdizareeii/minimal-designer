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

export type ManagedRetentionClass = keyof typeof BACKUP_RETENTION_POLICY;
export type BackupRetentionClass = "manual" | ManagedRetentionClass;

export interface BackupScheduleWindow {
  dueAt: string;
  nextDueAt: string;
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
