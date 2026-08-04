const crypto = require("crypto");

function googleCalendarApi() {
  // 保持加密与时间转换逻辑可在不安装线上依赖的本机环境中测试。
  // Render 运行服务时会从 package.json 安装 googleapis。
  return require("googleapis").google;
}

const CALENDAR_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created"
];

function tokenKey(clientSecret) {
  if (!clientSecret) throw new Error("ARC TODO Google Calendar 未配置。");
  return crypto.createHash("sha256").update(`arc-todo-calendar-token:v1:${clientSecret}`).digest();
}

function encryptRefreshToken(refreshToken, clientSecret) {
  if (!refreshToken) throw new Error("Google 未返回可持续使用的日历授权。请重新连接日历。");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey(clientSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(String(refreshToken), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptRefreshToken(ciphertext, clientSecret) {
  const [version, ivText, tagText, payloadText] = String(ciphertext || "").split(".");
  if (version !== "v1" || !ivText || !tagText || !payloadText) throw new Error("日历授权资料无效。请重新连接日历。");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey(clientSecret), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(payloadText, "base64url")), decipher.final()]).toString("utf8");
  } catch (_) {
    throw new Error("日历授权已失效。请重新连接日历。");
  }
}

function calendarClient({ clientId, clientSecret, refreshToken }) {
  if (!clientId || !clientSecret || !refreshToken) throw new Error("ARC TODO Google Calendar 未配置。");
  const google = googleCalendarApi();
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth });
}

function eventBody({ task, member, plan }) {
  return {
    summary: `ARC TODO · ${task.title}`,
    description: `ARC TODO 个人工作安排\\n\\n任务截止：${new Date(task.due_at).toLocaleString("zh-CN", { timeZone: task.timezone || "Asia/Kuala_Lumpur" })}\\n\\n${task.notes || ""}`,
    start: { dateTime: plan.planned_start_at || plan.plannedStartAt, timeZone: task.timezone || "Asia/Kuala_Lumpur" },
    end: { dateTime: plan.planned_end_at || plan.plannedEndAt, timeZone: task.timezone || "Asia/Kuala_Lumpur" },
    extendedProperties: { private: { arcTodoManaged: "1", arcTodoTaskId: String(task.id), arcTodoMemberId: String(member.id) } }
  };
}

function scheduleFromGoogleEvent(event) {
  const start = event?.start?.dateTime;
  const end = event?.end?.dateTime;
  if (!start || !end) return null;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) return null;
  return { plannedStartAt: startDate.toISOString(), plannedEndAt: endDate.toISOString() };
}

async function createArcTodoCalendar(calendar, timeZone = "Asia/Kuala_Lumpur") {
  const result = await calendar.calendars.insert({
    requestBody: {
      summary: "ARC TODO",
      description: "ARC TODO 创建的个人工作时间安排。可以在 ARC TODO 或 Google Calendar 中调整。",
      timeZone
    }
  });
  return { id: result.data.id, summary: result.data.summary || "ARC TODO", timeZone: result.data.timeZone || timeZone };
}

async function freeBusyForDay(calendar, start, end, timeZone) {
  const response = await calendar.freebusy.query({
    requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone, items: [{ id: "primary" }] }
  });
  return response.data.calendars?.primary?.busy || [];
}

async function upsertManagedEvent(calendar, calendarId, eventId, input) {
  const requestBody = eventBody(input);
  const response = eventId
    ? await calendar.events.update({ calendarId, eventId, sendUpdates: "none", requestBody })
    : await calendar.events.insert({ calendarId, sendUpdates: "none", requestBody });
  return response.data;
}

async function deleteManagedEvent(calendar, calendarId, eventId) {
  if (!calendarId || !eventId) return;
  try {
    await calendar.events.delete({ calendarId, eventId, sendUpdates: "none" });
  } catch (error) {
    if (Number(error?.code) !== 404) throw error;
  }
}

async function readManagedEvent(calendar, calendarId, eventId) {
  try {
    const response = await calendar.events.get({ calendarId, eventId });
    return response.data;
  } catch (error) {
    if (Number(error?.code) === 404) return null;
    throw error;
  }
}

module.exports = {
  CALENDAR_SCOPES,
  encryptRefreshToken,
  decryptRefreshToken,
  calendarClient,
  createArcTodoCalendar,
  freeBusyForDay,
  upsertManagedEvent,
  deleteManagedEvent,
  readManagedEvent,
  scheduleFromGoogleEvent
};
