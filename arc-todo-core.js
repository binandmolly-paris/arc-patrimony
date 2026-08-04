const crypto = require("crypto");

const VALID_PRIORITIES = new Set(["high", "normal", "low"]);
const VALID_STATUSES = new Set(["inbox", "assigned", "done"]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function canViewTask(member, task, collaboratorIds = []) {
  if (!member || !task) return false;
  if (member.role === "admin") return true;
  return task.created_by === member.id || task.assigned_to === member.id || collaboratorIds.includes(member.id);
}

function assertTaskParticipant(member, task, collaboratorIds = []) {
  if (!canViewTask(member, task, collaboratorIds)) {
    const error = new Error("无权访问这项任务");
    error.code = "FORBIDDEN";
    throw error;
  }
}

function canFocusTask(member, task, collaboratorIds = []) {
  if (!member || !task || task.status === "done") return false;
  return task.assigned_to === member.id || collaboratorIds.includes(member.id);
}

function clampText(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function parseDate(value, fallback = null) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function optionalDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const date = parseDate(value);
  if (date) return date;
  const error = new Error(`${label}无效`);
  error.code = "VALIDATION";
  throw error;
}

function normalizePlanInput(input) {
  const start = optionalDate(input?.startAt ?? input?.plannedStartAt ?? input?.planned_start_at, "开始时间");
  const end = optionalDate(input?.endAt ?? input?.plannedEndAt ?? input?.planned_end_at, "计划完成时间");
  if (Boolean(start) !== Boolean(end)) {
    const error = new Error("请同时填写开始时间和计划完成时间");
    error.code = "VALIDATION";
    throw error;
  }
  if (start && end && end <= start) {
    const error = new Error("计划完成时间需要晚于开始时间");
    error.code = "VALIDATION";
    throw error;
  }
  return { plannedStartAt: start?.toISOString() || null, plannedEndAt: end?.toISOString() || null };
}

function normalizeTaskInput(input, { fallbackDueAt = null } = {}) {
  const title = clampText(input?.title, 160);
  if (!title) {
    const error = new Error("任务内容不能为空");
    error.code = "VALIDATION";
    throw error;
  }
  const dueAt = parseDate(input?.dueAt || input?.due_at, fallbackDueAt);
  if (!dueAt) {
    const error = new Error("请填写有效的截止时间");
    error.code = "VALIDATION";
    throw error;
  }
  const rawStatus = String(input?.status || "assigned");
  const rawPriority = String(input?.priority || "normal");
  return {
    title,
    notes: clampText(input?.notes, 4000),
    dueAt: dueAt.toISOString(),
    timezone: clampText(input?.timezone, 64) || "Asia/Kuala_Lumpur",
    priority: VALID_PRIORITIES.has(rawPriority) ? rawPriority : "normal",
    status: VALID_STATUSES.has(rawStatus) ? rawStatus : "assigned"
  };
}

function reminderCheckpoints(dueAt) {
  const due = parseDate(dueAt);
  if (!due) throw new Error("Invalid due date");
  return [
    { key: "pre_due", at: new Date(due.getTime() - 24 * 60 * 60 * 1000) },
    { key: "due_day", at: new Date(due.getTime()) },
    { key: "overdue_day_3", at: new Date(due.getTime() + 3 * 24 * 60 * 60 * 1000) }
  ];
}

function dueCheckpointWindow(dueAt, now = new Date(), windowMinutes = 65) {
  const start = new Date(now.getTime() - windowMinutes * 60 * 1000);
  const end = new Date(now.getTime() + windowMinutes * 60 * 1000);
  return reminderCheckpoints(dueAt).filter((point) => point.at >= start && point.at <= end);
}

function normalizeLegacyTask(legacy, fallbackDueAt) {
  const safe = normalizeTaskInput({
    title: legacy?.title,
    notes: legacy?.notes,
    dueAt: legacy?.due,
    priority: legacy?.priority,
    status: legacy?.status === "done" ? "done" : "assigned",
    timezone: legacy?.timezone
  }, { fallbackDueAt });
  return {
    ...safe,
    legacyAssignee: String(legacy?.assignee || "").slice(0, 64),
    legacyCollaborator: String(legacy?.collaborator || "").slice(0, 64),
    completedAt: safe.status === "done" ? parseDate(legacy?.completedAt)?.toISOString() || new Date().toISOString() : null
  };
}

module.exports = {
  normalizeEmail,
  tokenHash,
  canViewTask,
  assertTaskParticipant,
  canFocusTask,
  normalizeTaskInput,
  normalizePlanInput,
  normalizeLegacyTask,
  reminderCheckpoints,
  dueCheckpointWindow
};
