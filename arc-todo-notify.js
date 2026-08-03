const { google } = require("googleapis");
const { reminderCheckpoints } = require("./arc-todo-core");

function integrationHealth() {
  return {
    calendarConfigured: Boolean(process.env.ARC_TODO_CALENDAR_ID && process.env.ARC_TODO_SERVICE_CLIENT_ID && process.env.ARC_TODO_SERVICE_CLIENT_SECRET && process.env.ARC_TODO_SERVICE_REFRESH_TOKEN),
    emailConfigured: Boolean(process.env.ARC_TODO_SERVICE_CLIENT_ID && process.env.ARC_TODO_SERVICE_CLIENT_SECRET && process.env.ARC_TODO_SERVICE_REFRESH_TOKEN)
  };
}

function serviceClients() {
  if (!integrationHealth().emailConfigured) return null;
  const oauth = new google.auth.OAuth2(process.env.ARC_TODO_SERVICE_CLIENT_ID, process.env.ARC_TODO_SERVICE_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: process.env.ARC_TODO_SERVICE_REFRESH_TOKEN });
  return { calendar: google.calendar({ version: "v3", auth: oauth }), gmail: google.gmail({ version: "v1", auth: oauth }) };
}

function taskUrl(taskId) {
  const origin = process.env.ARC_TODO_PUBLIC_ORIGIN || "https://arc-patrimony.onrender.com";
  return `${origin.replace(/\/$/, "")}/arc-todo/#task-${taskId}`;
}

function encodeSubject(subject) { return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`; }
function htmlEscape(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#039;", "\"":"&quot;" }[character])); }
function formatTaskEmail(task, checkpoint) {
  const labels = { assignment: "有一件新任务", pre_due: "任务将在 24 小时内到期", due_day: "任务今天到期", overdue_day_3: "任务已逾期三天" };
  const title = labels[checkpoint] || "ARC TODO 提醒";
  const due = new Intl.DateTimeFormat("zh-CN", { dateStyle:"long", timeStyle:"short", timeZone:task.timezone || "Asia/Kuala_Lumpur" }).format(new Date(task.due_at));
  const subject = `ARC TODO · ${title}：${task.title}`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#1d1d1f;line-height:1.6"><p style="margin:0 0 14px;color:#0071e3;font-size:12px;font-weight:700;letter-spacing:.08em">ARC TODO</p><h2 style="margin:0 0 12px;font-size:24px;letter-spacing:-.02em">${htmlEscape(task.title)}</h2><p style="margin:0 0 10px;color:#515154">${htmlEscape(title)}</p><p style="margin:0 0 18px;padding:12px 14px;background:#f5f5f7;border-radius:10px"><b>截止：</b>${htmlEscape(due)}<br><b>创建：</b>${htmlEscape(task.creator_name)}<br><b>负责：</b>${htmlEscape(task.assignee_name)}</p>${task.notes ? `<p style="margin:0 0 18px;color:#515154">${htmlEscape(task.notes)}</p>` : ""}<a href="${taskUrl(task.id)}" style="display:inline-block;padding:10px 15px;color:white;background:#0071e3;border-radius:999px;text-decoration:none">打开 ARC TODO</a><p style="margin:22px 0 0;color:#86868b;font-size:12px">这是 ARC TODO 的家庭任务提醒。</p></div>`;
  return { subject, html };
}

async function loadDeliveryTask(pool, taskId) {
  const result = await pool.query(
    `SELECT t.*, creator.display_name AS creator_name, assignee.display_name AS assignee_name, assignee.email AS assignee_email
       FROM arc_todo_tasks t
       JOIN arc_todo_members creator ON creator.id=t.created_by
       JOIN arc_todo_members assignee ON assignee.id=t.assigned_to
      WHERE t.id=$1 AND t.archived_at IS NULL`, [taskId]
  );
  return result.rows[0] || null;
}

async function recordDelivery(pool, taskId, checkpoint, channel, status, errorMessage = null) {
  const result = await pool.query(
    `INSERT INTO arc_todo_notification_log (task_id, checkpoint, channel, status, sent_at, error_message)
     VALUES ($1,$2,$3,$4,CASE WHEN $4='sent' THEN NOW() ELSE NULL END,$5)
     ON CONFLICT (task_id, checkpoint, channel) DO UPDATE
       SET status=EXCLUDED.status, sent_at=CASE WHEN EXCLUDED.status='sent' THEN NOW() ELSE arc_todo_notification_log.sent_at END, error_message=EXCLUDED.error_message
     RETURNING *`, [taskId, checkpoint, channel, status, errorMessage]
  );
  return result.rows[0];
}

async function wasSent(pool, taskId, checkpoint, channel) {
  const result = await pool.query("SELECT 1 FROM arc_todo_notification_log WHERE task_id=$1 AND checkpoint=$2 AND channel=$3 AND status='sent'", [taskId, checkpoint, channel]);
  return Boolean(result.rows.length);
}

async function syncCalendar(clients, pool, task, checkpoint) {
  if (!integrationHealth().calendarConfigured || await wasSent(pool, task.id, checkpoint, "calendar")) return false;
  const due = new Date(task.due_at); const end = new Date(due.getTime() + 30 * 60 * 1000);
  const requestBody = {
    summary: `ARC TODO · ${task.title}`,
    description: `ARC TODO 家庭任务\n\n创建：${task.creator_name}\n负责：${task.assignee_name}\n\n${task.notes || ""}\n\n${taskUrl(task.id)}`,
    start: { dateTime: due.toISOString(), timeZone: task.timezone || "Asia/Kuala_Lumpur" },
    end: { dateTime: end.toISOString(), timeZone: task.timezone || "Asia/Kuala_Lumpur" },
    attendees: [{ email: task.assignee_email }],
    reminders: { useDefault: false, overrides: [{ method:"popup", minutes:60 }, { method:"email", minutes:1440 }] }
  };
  try {
    const response = task.calendar_event_id
      ? await clients.calendar.events.update({ calendarId:process.env.ARC_TODO_CALENDAR_ID, eventId:task.calendar_event_id, sendUpdates:"all", requestBody })
      : await clients.calendar.events.insert({ calendarId:process.env.ARC_TODO_CALENDAR_ID, sendUpdates:"all", requestBody });
    if (!task.calendar_event_id) await pool.query("UPDATE arc_todo_tasks SET calendar_event_id=$1, delivery_state='connected', updated_at=NOW() WHERE id=$2", [response.data.id, task.id]);
    await recordDelivery(pool, task.id, checkpoint, "calendar", "sent");
    return true;
  } catch (error) {
    await recordDelivery(pool, task.id, checkpoint, "calendar", "failed", error.message);
    await pool.query("UPDATE arc_todo_tasks SET delivery_state='needs_attention', updated_at=NOW() WHERE id=$1", [task.id]);
    return false;
  }
}

async function sendEmail(clients, pool, task, checkpoint) {
  if (await wasSent(pool, task.id, checkpoint, "email")) return false;
  const { subject, html } = formatTaskEmail(task, checkpoint);
  const message = `To: ${task.assignee_email}\r\nSubject: ${encodeSubject(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}`;
  try {
    const raw = Buffer.from(message, "utf8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    await clients.gmail.users.messages.send({ userId:"me", requestBody:{ raw } });
    await recordDelivery(pool, task.id, checkpoint, "email", "sent");
    return true;
  } catch (error) {
    await recordDelivery(pool, task.id, checkpoint, "email", "failed", error.message);
    await pool.query("UPDATE arc_todo_tasks SET delivery_state='needs_attention', updated_at=NOW() WHERE id=$1", [task.id]);
    return false;
  }
}

async function deliverTask(pool, taskId, checkpoint) {
  const health = integrationHealth();
  if (!health.emailConfigured) return { connected:false, calendar:false, email:false };
  const task = await loadDeliveryTask(pool, taskId);
  if (!task || task.status === "done") return { connected:true, calendar:false, email:false };
  const clients = serviceClients();
  const [calendar, email] = await Promise.all([syncCalendar(clients, pool, task, checkpoint), sendEmail(clients, pool, task, checkpoint)]);
  return { connected:true, calendar, email };
}

async function runReminderDispatch(pool, now = new Date()) {
  if (!integrationHealth().emailConfigured) return { configured:false, checked:0, delivered:0 };
  const tasks = await pool.query(
    `SELECT id, due_at FROM arc_todo_tasks
      WHERE archived_at IS NULL AND status <> 'done'
        AND due_at BETWEEN $1 AND $2`,
    [new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000), new Date(now.getTime() + 25 * 60 * 60 * 1000)]
  );
  let delivered = 0;
  for (const task of tasks.rows) {
    const checkpoints = reminderCheckpoints(task.due_at).filter((point) => point.at <= now && point.at >= new Date(now.getTime() - 70 * 60 * 1000));
    for (const point of checkpoints) {
      const result = await deliverTask(pool, task.id, point.key);
      if (result.calendar || result.email) delivered++;
    }
  }
  return { configured:true, checked:tasks.rows.length, delivered };
}

module.exports = { integrationHealth, deliverTask, runReminderDispatch };
