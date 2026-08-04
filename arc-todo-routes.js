const crypto = require("crypto");
const { google } = require("googleapis");
const {
  normalizeEmail,
  tokenHash,
  canViewTask,
  assertTaskParticipant,
  canFocusTask,
  normalizeTaskInput,
  normalizePlanInput,
  normalizeLegacyTask
} = require("./arc-todo-core");
const { integrationHealth, deliverTask, runReminderDispatch } = require("./arc-todo-notify");

const COOKIE_NAME = "arc_todo_session";
const SESSION_DAYS = 30;
const OAUTH_STATE_MINUTES = 10;

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function setSessionCookie(res, token, expiresAt) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function getGoogleLoginClient() {
  const clientId = process.env.ARC_TODO_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.ARC_TODO_GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.ARC_TODO_GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function memberConfig() {
  return [
    { role: "admin", email: process.env.ARC_TODO_ADMIN_EMAIL, displayName: process.env.ARC_TODO_ADMIN_NAME || "Administrator" },
    { role: "member", email: process.env.ARC_TODO_MOLLY_EMAIL, displayName: process.env.ARC_TODO_MOLLY_NAME || "Molly" },
    { role: "member", email: process.env.ARC_TODO_YUKUN_EMAIL, displayName: process.env.ARC_TODO_YUKUN_NAME || "Yukun" }
  ].filter((member) => normalizeEmail(member.email));
}

async function initArcTodoDB(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arc_todo_members (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS arc_todo_tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      due_at TIMESTAMPTZ NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
      status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('inbox', 'assigned', 'done')),
      created_by INTEGER NOT NULL REFERENCES arc_todo_members(id),
      assigned_to INTEGER NOT NULL REFERENCES arc_todo_members(id),
      calendar_event_id TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'pending_connection',
      planned_start_at TIMESTAMPTZ,
      planned_end_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS arc_todo_collaborators (
      task_id INTEGER NOT NULL REFERENCES arc_todo_tasks(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES arc_todo_members(id),
      PRIMARY KEY (task_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS arc_todo_activity (
      id BIGSERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES arc_todo_tasks(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES arc_todo_members(id),
      event_type TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS arc_todo_sessions (
      token_hash TEXT PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES arc_todo_members(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS arc_todo_oauth_states (
      state_hash TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS arc_todo_notification_log (
      id BIGSERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES arc_todo_tasks(id) ON DELETE CASCADE,
      checkpoint TEXT NOT NULL CHECK (checkpoint IN ('assignment', 'updated', 'pre_due', 'due_day', 'overdue_day_3', 'completion')),
      channel TEXT NOT NULL CHECK (channel IN ('app', 'calendar', 'email')),
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at TIMESTAMPTZ,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(task_id, checkpoint, channel)
    );
    ALTER TABLE arc_todo_tasks ADD COLUMN IF NOT EXISTS planned_start_at TIMESTAMPTZ;
    ALTER TABLE arc_todo_tasks ADD COLUMN IF NOT EXISTS planned_end_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS arc_todo_focus_sessions (
      id BIGSERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES arc_todo_members(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES arc_todo_tasks(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER,
      ended_reason TEXT CHECK (ended_reason IN ('paused', 'completed', 'cleared', 'switched')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS arc_todo_focus_states (
      member_id INTEGER PRIMARY KEY REFERENCES arc_todo_members(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES arc_todo_tasks(id) ON DELETE CASCADE,
      selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active_session_id BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS arc_todo_task_plans (
      member_id INTEGER NOT NULL REFERENCES arc_todo_members(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES arc_todo_tasks(id) ON DELETE CASCADE,
      planned_start_at TIMESTAMPTZ NOT NULL,
      planned_end_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (member_id, task_id),
      CHECK (planned_end_at > planned_start_at)
    );
    INSERT INTO arc_todo_task_plans (member_id, task_id, planned_start_at, planned_end_at)
      SELECT assigned_to, id, planned_start_at, planned_end_at
        FROM arc_todo_tasks
       WHERE planned_start_at IS NOT NULL AND planned_end_at IS NOT NULL
      ON CONFLICT (member_id, task_id) DO NOTHING;
    CREATE INDEX IF NOT EXISTS idx_arc_todo_tasks_due_open ON arc_todo_tasks (due_at) WHERE status <> 'done' AND archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_arc_todo_tasks_assigned ON arc_todo_tasks (assigned_to, due_at DESC);
    CREATE INDEX IF NOT EXISTS idx_arc_todo_collaborators_member ON arc_todo_collaborators (member_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_arc_todo_activity_task ON arc_todo_activity (task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_arc_todo_focus_sessions_member ON arc_todo_focus_sessions (member_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_arc_todo_focus_states_task ON arc_todo_focus_states (task_id);
    CREATE INDEX IF NOT EXISTS idx_arc_todo_task_plans_member_time ON arc_todo_task_plans (member_id, planned_start_at);
  `);
}

async function seedArcTodoMembers(pool) {
  for (const member of memberConfig()) {
    await pool.query(
      `INSERT INTO arc_todo_members (email, display_name, role, active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name, role=EXCLUDED.role, active=TRUE, updated_at=NOW()`,
      [normalizeEmail(member.email), member.displayName, member.role]
    );
  }
}

async function createSession(pool, memberId) {
  const raw = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query("INSERT INTO arc_todo_sessions (token_hash, member_id, expires_at) VALUES ($1, $2, $3)", [tokenHash(raw), memberId, expiresAt]);
  return { raw, expiresAt };
}

async function currentMember(pool, req) {
  const token = parseCookies(req.headers.cookie || "")[COOKIE_NAME];
  if (!token) return null;
  const result = await pool.query(
    `SELECT m.id, m.email, m.display_name, m.role
       FROM arc_todo_sessions s
       JOIN arc_todo_members m ON m.id=s.member_id
      WHERE s.token_hash=$1 AND s.expires_at > NOW() AND m.active=TRUE`,
    [tokenHash(token)]
  );
  if (!result.rows.length) return null;
  await pool.query("UPDATE arc_todo_sessions SET last_used_at=NOW() WHERE token_hash=$1", [tokenHash(token)]).catch(() => {});
  return result.rows[0];
}

async function requireMember(pool, req, res, next) {
  try {
    const member = await currentMember(pool, req);
    if (!member) return res.status(401).json({ error: "请使用获授权的 Google 账户登录。" });
    req.arcTodoMember = member;
    next();
  } catch (error) {
    console.error("ARC TODO session verification failed:", error.message);
    res.status(500).json({ error: "ARC TODO 认证暂不可用。" });
  }
}

async function loadTask(pool, taskId) {
  const taskResult = await pool.query("SELECT * FROM arc_todo_tasks WHERE id=$1 AND archived_at IS NULL", [taskId]);
  if (!taskResult.rows.length) return null;
  const collabResult = await pool.query("SELECT member_id FROM arc_todo_collaborators WHERE task_id=$1", [taskId]);
  return { task: taskResult.rows[0], collaboratorIds: collabResult.rows.map((row) => row.member_id) };
}

async function ensureMemberExists(pool, memberId) {
  const result = await pool.query("SELECT id FROM arc_todo_members WHERE id=$1 AND active=TRUE", [memberId]);
  if (!result.rows.length) {
    const error = new Error("负责人不存在或已停用");
    error.code = "VALIDATION";
    throw error;
  }
}

async function writeActivity(pool, taskId, actorId, eventType, detail = {}) {
  await pool.query(
    "INSERT INTO arc_todo_activity (task_id, actor_id, event_type, detail) VALUES ($1, $2, $3, $4::jsonb)",
    [taskId, actorId || null, eventType, JSON.stringify(detail)]
  );
}

async function taskView(pool, task) {
  const members = await pool.query(
    `SELECT m.id, m.display_name, m.role
       FROM arc_todo_collaborators c JOIN arc_todo_members m ON m.id=c.member_id
      WHERE c.task_id=$1 ORDER BY m.display_name`, [task.id]
  );
  const names = await pool.query(
    `SELECT creator.display_name AS creator_name, assignee.display_name AS assignee_name
       FROM arc_todo_tasks t
       JOIN arc_todo_members creator ON creator.id=t.created_by
       JOIN arc_todo_members assignee ON assignee.id=t.assigned_to
      WHERE t.id=$1`, [task.id]
  );
  return { ...task, ...names.rows[0], collaborators: members.rows };
}

function publicMember(member) {
  return { id: member.id, displayName: member.display_name, role: member.role };
}

async function currentFocus(pool, memberId) {
  const result = await pool.query(
    `SELECT f.task_id, f.selected_at, f.active_session_id, s.started_at AS session_started_at
       FROM arc_todo_focus_states f
       JOIN arc_todo_tasks t ON t.id=f.task_id AND t.archived_at IS NULL AND t.status <> 'done'
       LEFT JOIN arc_todo_focus_sessions s ON s.id=f.active_session_id AND s.ended_at IS NULL
      WHERE f.member_id=$1`,
    [memberId]
  );
  if (!result.rows.length) return null;
  const focus = result.rows[0];
  return {
    taskId: focus.task_id,
    selectedAt: focus.selected_at,
    activeSession: focus.active_session_id && focus.session_started_at ? { id: focus.active_session_id, startedAt: focus.session_started_at } : null
  };
}

async function focusCandidates(pool, memberId, currentTaskId = null) {
  const result = await pool.query(
    `SELECT t.id, t.title, t.due_at, p.planned_start_at AS personal_planned_start_at,
            p.planned_end_at AS personal_planned_end_at, t.priority
       FROM arc_todo_tasks t
       LEFT JOIN arc_todo_task_plans p ON p.task_id=t.id AND p.member_id=$1
      WHERE t.archived_at IS NULL AND t.status <> 'done'
        AND (t.assigned_to=$1 OR EXISTS (
          SELECT 1 FROM arc_todo_collaborators c WHERE c.task_id=t.id AND c.member_id=$1
        ))
        AND ($2::int IS NULL OR t.id <> $2)
      ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
               COALESCE(p.planned_start_at, t.due_at), t.id DESC
      LIMIT 12`,
    [memberId, currentTaskId]
  );
  return result.rows;
}

async function familyFocusTitles(pool) {
  const result = await pool.query(
    `SELECT m.id AS member_id, m.display_name, t.id AS task_id, t.title
       FROM arc_todo_focus_states f
       JOIN arc_todo_members m ON m.id=f.member_id AND m.active=TRUE
       JOIN arc_todo_tasks t ON t.id=f.task_id AND t.archived_at IS NULL AND t.status <> 'done'
      ORDER BY m.display_name`
  );
  return result.rows.map((row) => ({ memberId: row.member_id, displayName: row.display_name, taskId: row.task_id, title: row.title }));
}

async function endFocusForMember(pool, memberId, reason) {
  const result = await pool.query(
    "SELECT task_id, selected_at, active_session_id FROM arc_todo_focus_states WHERE member_id=$1",
    [memberId]
  );
  if (!result.rows.length) return null;
  const focus = result.rows[0];
  if (focus.active_session_id) {
    await pool.query(
      `UPDATE arc_todo_focus_sessions
          SET ended_at=NOW(), duration_seconds=GREATEST(0, FLOOR(EXTRACT(EPOCH FROM NOW()-started_at))::int), ended_reason=$2
        WHERE id=$1 AND ended_at IS NULL`,
      [focus.active_session_id, reason]
    );
  }
  await pool.query("DELETE FROM arc_todo_focus_states WHERE member_id=$1", [memberId]);
  return { taskId: focus.task_id, selectedAt: focus.selected_at, activeSession: focus.active_session_id ? { id: focus.active_session_id } : null };
}

async function endFocusForTask(pool, taskId, reason) {
  const active = await pool.query("SELECT member_id FROM arc_todo_focus_states WHERE task_id=$1", [taskId]);
  for (const state of active.rows) await endFocusForMember(pool, state.member_id, reason);
}

async function focusPayload(pool, member) {
  const focus = await currentFocus(pool, member.id);
  return {
    focus,
    candidates: await focusCandidates(pool, member.id, focus?.taskId || null),
    familyPriorities: member.role === "admin" ? await familyFocusTitles(pool) : []
  };
}

function registerArcTodoRoutes(app, pool) {
  app.get("/api/arc-todo/health", async (_req, res) => {
    try {
      const result = await pool.query("SELECT COUNT(*)::int AS members FROM arc_todo_members WHERE active=TRUE");
      res.json({
        ok: true,
        membersConfigured: result.rows[0].members,
        googleLoginConfigured: Boolean(getGoogleLoginClient()),
        ...integrationHealth()
      });
    } catch (error) {
      res.status(503).json({ ok: false, error: "ARC TODO database is not ready." });
    }
  });

  app.get("/api/arc-todo/auth/google", async (_req, res) => {
    const client = getGoogleLoginClient();
    if (!client) return res.status(503).send("ARC TODO Google 登录尚未配置。");
    const state = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + OAUTH_STATE_MINUTES * 60 * 1000);
    await pool.query("INSERT INTO arc_todo_oauth_states (state_hash, expires_at) VALUES ($1, $2)", [tokenHash(state), expiresAt]);
    const url = client.generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      state,
      prompt: "select_account"
    });
    res.redirect(url);
  });

  app.get("/api/arc-todo/auth/google/callback", async (req, res) => {
    try {
      const client = getGoogleLoginClient();
      const state = String(req.query.state || "");
      const code = String(req.query.code || "");
      if (!client || !state || !code) return res.status(400).send("ARC TODO 登录参数不完整。请返回重试。");
      const stateResult = await pool.query(
        "DELETE FROM arc_todo_oauth_states WHERE state_hash=$1 AND expires_at > NOW() RETURNING state_hash",
        [tokenHash(state)]
      );
      if (!stateResult.rows.length) return res.status(400).send("ARC TODO 登录已过期。请重新开始。");
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) return res.status(400).send("Google 未返回身份凭证。请重新登录。");
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.ARC_TODO_GOOGLE_CLIENT_ID });
      const email = normalizeEmail(ticket.getPayload()?.email);
      const result = await pool.query("SELECT id, email, display_name, role FROM arc_todo_members WHERE email=$1 AND active=TRUE", [email]);
      if (!result.rows.length) return res.status(403).send("这个 Google 账户尚未获 ARC TODO 授权。");
      const session = await createSession(pool, result.rows[0].id);
      setSessionCookie(res, session.raw, session.expiresAt);
      res.redirect("/arc-todo/");
    } catch (error) {
      console.error("ARC TODO Google callback failed:", error.message);
      res.status(500).send("ARC TODO 登录失败。请稍后重试。");
    }
  });

  app.get("/api/arc-todo/auth/me", requireMember.bind(null, pool), (req, res) => res.json({ member: publicMember(req.arcTodoMember) }));
  app.post("/api/arc-todo/auth/logout", requireMember.bind(null, pool), async (req, res) => {
    const token = parseCookies(req.headers.cookie || "")[COOKIE_NAME];
    if (token) await pool.query("DELETE FROM arc_todo_sessions WHERE token_hash=$1", [tokenHash(token)]).catch(() => {});
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/arc-todo/members", requireMember.bind(null, pool), async (_req, res) => {
    const result = await pool.query("SELECT id, display_name, role FROM arc_todo_members WHERE active=TRUE ORDER BY role DESC, display_name");
    res.json({ members: result.rows.map((member) => publicMember(member)) });
  });

  app.get("/api/arc-todo/tasks", requireMember.bind(null, pool), async (req, res) => {
    const member = req.arcTodoMember;
    const result = await pool.query(
      `SELECT t.id, t.title, t.notes, t.due_at, t.timezone, t.priority, t.status, t.created_by, t.assigned_to,
              t.calendar_event_id, t.delivery_state, t.completed_at, t.created_at, t.updated_at, t.archived_at,
              p.planned_start_at AS personal_planned_start_at, p.planned_end_at AS personal_planned_end_at,
              creator.display_name AS creator_name, assignee.display_name AS assignee_name
         FROM arc_todo_tasks t
         JOIN arc_todo_members creator ON creator.id=t.created_by
         JOIN arc_todo_members assignee ON assignee.id=t.assigned_to
         LEFT JOIN arc_todo_task_plans p ON p.task_id=t.id AND p.member_id=$2
        WHERE t.archived_at IS NULL
          AND ($1='admin' OR t.created_by=$2 OR t.assigned_to=$2
               OR EXISTS (SELECT 1 FROM arc_todo_collaborators c WHERE c.task_id=t.id AND c.member_id=$2))
        ORDER BY CASE WHEN t.status='done' THEN 1 ELSE 0 END, t.due_at ASC, t.id DESC`,
      [member.role, member.id]
    );
    const taskIds = result.rows.map((task) => task.id);
    const collabs = taskIds.length ? await pool.query(
      `SELECT c.task_id, m.id, m.display_name, m.role
         FROM arc_todo_collaborators c JOIN arc_todo_members m ON m.id=c.member_id
        WHERE c.task_id = ANY($1::int[]) ORDER BY m.display_name`, [taskIds]
    ) : { rows: [] };
    const collaboratorMap = new Map();
    collabs.rows.forEach((row) => collaboratorMap.set(row.task_id, [...(collaboratorMap.get(row.task_id) || []), publicMember(row)]));
    res.json({ tasks: result.rows.map((task) => ({ ...task, collaborators: collaboratorMap.get(task.id) || [] })) });
  });

  app.get("/api/arc-todo/focus", requireMember.bind(null, pool), async (req, res) => {
    try {
      res.json(await focusPayload(pool, req.arcTodoMember));
    } catch (error) {
      res.status(500).json({ error: "无法读取当前重点。" });
    }
  });

  app.post("/api/arc-todo/focus/current", requireMember.bind(null, pool), async (req, res) => {
    try {
      const taskId = Number(req.body?.taskId);
      const loaded = await loadTask(pool, taskId);
      if (!loaded) return res.status(404).json({ error: "任务不存在。" });
      if (!canFocusTask(req.arcTodoMember, loaded.task, loaded.collaboratorIds)) return res.status(403).json({ error: "只能选择由您负责或共同参与的未完成任务。" });
      await endFocusForMember(pool, req.arcTodoMember.id, "switched");
      await pool.query(
        `INSERT INTO arc_todo_focus_states (member_id, task_id, selected_at, updated_at)
         VALUES ($1,$2,NOW(),NOW())
         ON CONFLICT (member_id) DO UPDATE SET task_id=EXCLUDED.task_id, selected_at=NOW(), active_session_id=NULL, updated_at=NOW()`,
        [req.arcTodoMember.id, taskId]
      );
      await writeActivity(pool, taskId, req.arcTodoMember.id, "focus_selected");
      res.json(await focusPayload(pool, req.arcTodoMember));
    } catch (error) {
      res.status(error.code === "FORBIDDEN" || error.code === "VALIDATION" ? 400 : 500).json({ error: error.message || "无法设定当前重点。" });
    }
  });

  app.delete("/api/arc-todo/focus/current", requireMember.bind(null, pool), async (req, res) => {
    try {
      await endFocusForMember(pool, req.arcTodoMember.id, "cleared");
      res.json(await focusPayload(pool, req.arcTodoMember));
    } catch (error) {
      res.status(500).json({ error: "无法移除当前重点。" });
    }
  });

  app.post("/api/arc-todo/focus/start", requireMember.bind(null, pool), async (req, res) => {
    try {
      const focus = await currentFocus(pool, req.arcTodoMember.id);
      if (!focus) return res.status(400).json({ error: "请先选择当前重点。" });
      if (!focus.activeSession) {
        const session = await pool.query(
          "INSERT INTO arc_todo_focus_sessions (member_id, task_id) VALUES ($1,$2) RETURNING id",
          [req.arcTodoMember.id, focus.taskId]
        );
        await pool.query("UPDATE arc_todo_focus_states SET active_session_id=$1, updated_at=NOW() WHERE member_id=$2", [session.rows[0].id, req.arcTodoMember.id]);
        await writeActivity(pool, focus.taskId, req.arcTodoMember.id, "focus_started");
      }
      res.json(await focusPayload(pool, req.arcTodoMember));
    } catch (error) {
      res.status(500).json({ error: "无法开始专注。" });
    }
  });

  app.post("/api/arc-todo/focus/pause", requireMember.bind(null, pool), async (req, res) => {
    try {
      const focus = await endFocusForMember(pool, req.arcTodoMember.id, "paused");
      if (focus) await writeActivity(pool, focus.taskId, req.arcTodoMember.id, "focus_paused");
      res.json(await focusPayload(pool, req.arcTodoMember));
    } catch (error) {
      res.status(500).json({ error: "无法暂停专注。" });
    }
  });

  app.post("/api/arc-todo/tasks", requireMember.bind(null, pool), async (req, res) => {
    try {
      const input = normalizeTaskInput(req.body);
      const assignedTo = Number(req.body.assignedTo || req.arcTodoMember.id);
      const collaboratorId = req.body.collaboratorId ? Number(req.body.collaboratorId) : null;
      await ensureMemberExists(pool, assignedTo);
      if (collaboratorId) await ensureMemberExists(pool, collaboratorId);
      const result = await pool.query(
        `INSERT INTO arc_todo_tasks (title, notes, due_at, timezone, priority, status, created_by, assigned_to, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [input.title, input.notes, input.dueAt, input.timezone, input.priority, input.status, req.arcTodoMember.id, assignedTo, input.status === "done" ? new Date() : null]
      );
      const task = result.rows[0];
      if (collaboratorId && collaboratorId !== assignedTo && collaboratorId !== req.arcTodoMember.id) {
        await pool.query("INSERT INTO arc_todo_collaborators (task_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [task.id, collaboratorId]);
      }
      await writeActivity(pool, task.id, req.arcTodoMember.id, "created", { assignedTo });
      await deliverTask(pool, task.id, "assignment").catch((error) => console.error("ARC TODO assignment delivery failed:", error.message));
      res.status(201).json({ task: await taskView(pool, task) });
    } catch (error) {
      res.status(error.code === "VALIDATION" ? 400 : 500).json({ error: error.message || "创建任务失败。" });
    }
  });

  app.patch("/api/arc-todo/tasks/:id", requireMember.bind(null, pool), async (req, res) => {
    try {
      const loaded = await loadTask(pool, Number(req.params.id));
      if (!loaded) return res.status(404).json({ error: "任务不存在。" });
      assertTaskParticipant(req.arcTodoMember, loaded.task, loaded.collaboratorIds);
      const input = normalizeTaskInput({ ...loaded.task, ...req.body, dueAt: req.body.dueAt || loaded.task.due_at });
      const assignedTo = req.body.assignedTo ? Number(req.body.assignedTo) : loaded.task.assigned_to;
      const collaboratorId = req.body.collaboratorId === null ? null : (req.body.collaboratorId ? Number(req.body.collaboratorId) : undefined);
      const nextCollaboratorIds = collaboratorId && collaboratorId !== assignedTo && collaboratorId !== req.arcTodoMember.id ? [collaboratorId] : [];
      const collaboratorChanged = collaboratorId !== undefined && (loaded.collaboratorIds.length !== nextCollaboratorIds.length || loaded.collaboratorIds.some((id) => !nextCollaboratorIds.includes(id)));
      await ensureMemberExists(pool, assignedTo);
      const result = await pool.query(
        `UPDATE arc_todo_tasks
            SET title=$1, notes=$2, due_at=$3, timezone=$4, priority=$5, status=$6, assigned_to=$7,
                completed_at=CASE WHEN $6='done' THEN COALESCE(completed_at, NOW()) ELSE NULL END,
                delivery_state=CASE WHEN due_at <> $3::timestamptz OR assigned_to <> $7 THEN 'pending_connection' ELSE delivery_state END,
                updated_at=NOW()
          WHERE id=$8 RETURNING *`,
        [input.title, input.notes, input.dueAt, input.timezone, input.priority, input.status, assignedTo, loaded.task.id]
      );
      if (input.status === "done") await endFocusForTask(pool, loaded.task.id, "completed");
      if (collaboratorId !== undefined) {
        await pool.query("DELETE FROM arc_todo_collaborators WHERE task_id=$1", [loaded.task.id]);
        if (collaboratorId && collaboratorId !== assignedTo && collaboratorId !== req.arcTodoMember.id) {
          await ensureMemberExists(pool, collaboratorId);
          await pool.query("INSERT INTO arc_todo_collaborators (task_id, member_id) VALUES ($1,$2)", [loaded.task.id, collaboratorId]);
        }
      }
      if (input.status !== "done" && (assignedTo !== loaded.task.assigned_to || collaboratorChanged)) await endFocusForTask(pool, loaded.task.id, "cleared");
      await writeActivity(pool, loaded.task.id, req.arcTodoMember.id, "updated", { assignedTo });
      await deliverTask(pool, loaded.task.id, "updated").catch((error) => console.error("ARC TODO update delivery failed:", error.message));
      res.json({ task: await taskView(pool, result.rows[0]) });
    } catch (error) {
      const status = error.code === "FORBIDDEN" ? 403 : (error.code === "VALIDATION" ? 400 : 500);
      res.status(status).json({ error: error.message || "更新任务失败。" });
    }
  });

  app.put("/api/arc-todo/tasks/:id/plan", requireMember.bind(null, pool), async (req, res) => {
    try {
      const loaded = await loadTask(pool, Number(req.params.id));
      if (!loaded) return res.status(404).json({ error: "任务不存在。" });
      if (!canFocusTask(req.arcTodoMember, loaded.task, loaded.collaboratorIds)) return res.status(403).json({ error: "只能为由您负责或共同参与的未完成任务安排时间。" });
      const plan = normalizePlanInput(req.body);
      if (!plan.plannedStartAt || !plan.plannedEndAt) return res.status(400).json({ error: "请同时填写开始时间和计划完成时间。" });
      await pool.query(
        `INSERT INTO arc_todo_task_plans (member_id, task_id, planned_start_at, planned_end_at, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (member_id, task_id) DO UPDATE
           SET planned_start_at=EXCLUDED.planned_start_at, planned_end_at=EXCLUDED.planned_end_at, updated_at=NOW()`,
        [req.arcTodoMember.id, loaded.task.id, plan.plannedStartAt, plan.plannedEndAt]
      );
      await writeActivity(pool, loaded.task.id, req.arcTodoMember.id, "personal_plan_updated");
      res.json({ plan });
    } catch (error) {
      res.status(error.code === "VALIDATION" ? 400 : 500).json({ error: error.message || "安排时间失败。" });
    }
  });

  app.delete("/api/arc-todo/tasks/:id/plan", requireMember.bind(null, pool), async (req, res) => {
    try {
      const loaded = await loadTask(pool, Number(req.params.id));
      if (!loaded) return res.status(404).json({ error: "任务不存在。" });
      if (!canFocusTask(req.arcTodoMember, loaded.task, loaded.collaboratorIds)) return res.status(403).json({ error: "只能移除自己的计划时间。" });
      await pool.query("DELETE FROM arc_todo_task_plans WHERE member_id=$1 AND task_id=$2", [req.arcTodoMember.id, loaded.task.id]);
      await writeActivity(pool, loaded.task.id, req.arcTodoMember.id, "personal_plan_cleared");
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "移除计划时间失败。" });
    }
  });

  app.post("/api/arc-todo/tasks/:id/complete", requireMember.bind(null, pool), async (req, res) => {
    try {
      const loaded = await loadTask(pool, Number(req.params.id));
      if (!loaded) return res.status(404).json({ error: "任务不存在。" });
      assertTaskParticipant(req.arcTodoMember, loaded.task, loaded.collaboratorIds);
      const result = await pool.query("UPDATE arc_todo_tasks SET status='done', completed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *", [loaded.task.id]);
      await endFocusForTask(pool, loaded.task.id, "completed");
      await writeActivity(pool, loaded.task.id, req.arcTodoMember.id, "completed");
      res.json({ task: await taskView(pool, result.rows[0]) });
    } catch (error) {
      res.status(error.code === "FORBIDDEN" ? 403 : 500).json({ error: error.message || "完成任务失败。" });
    }
  });

  app.post("/api/arc-todo/import/legacy", requireMember.bind(null, pool), async (req, res) => {
    try {
      if (req.arcTodoMember.role !== "admin") return res.status(403).json({ error: "只有家庭管理员可以执行旧版资料导入。" });
      const legacyTasks = Array.isArray(req.body?.export?.tasks) ? req.body.export.tasks : [];
      const memberMap = req.body?.memberMap || {};
      if (!legacyTasks.length || legacyTasks.length > 200) return res.status(400).json({ error: "请选择包含 1 到 200 项待办的 ARC TODO 备份文件。" });
      const members = await pool.query("SELECT id FROM arc_todo_members WHERE active=TRUE");
      const validMemberIds = new Set(members.rows.map((member) => member.id));
      const imported = [];
      for (const legacy of legacyTasks) {
        const safe = normalizeLegacyTask(legacy, new Date(Date.now() + 24 * 60 * 60 * 1000));
        const mappedAssignee = Number(memberMap[safe.legacyAssignee]) || req.arcTodoMember.id;
        const mappedCollaborator = Number(memberMap[safe.legacyCollaborator]);
        const assignedTo = validMemberIds.has(mappedAssignee) ? mappedAssignee : req.arcTodoMember.id;
        const result = await pool.query(
          `INSERT INTO arc_todo_tasks (title, notes, due_at, timezone, priority, status, created_by, assigned_to, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [safe.title, safe.notes, safe.dueAt, safe.timezone, safe.priority, safe.status, req.arcTodoMember.id, assignedTo, safe.completedAt]
        );
        const task = result.rows[0];
        if (validMemberIds.has(mappedCollaborator) && mappedCollaborator !== assignedTo && mappedCollaborator !== req.arcTodoMember.id) {
          await pool.query("INSERT INTO arc_todo_collaborators (task_id, member_id) VALUES ($1,$2)", [task.id, mappedCollaborator]);
        }
        await writeActivity(pool, task.id, req.arcTodoMember.id, "legacy_imported", { legacyId: String(legacy.id || "") });
        imported.push(task.id);
      }
      res.status(201).json({ ok: true, importedCount: imported.length });
    } catch (error) {
      res.status(error.code === "VALIDATION" ? 400 : 500).json({ error: error.message || "导入失败。" });
    }
  });

  app.post("/api/arc-todo/cron/reminders", async (req, res) => {
    const token = req.headers["x-arc-todo-cron-token"];
    if (!process.env.ARC_TODO_CRON_SECRET) return res.status(503).json({ error: "ARC TODO reminder scheduler is not configured." });
    if (!token || token !== process.env.ARC_TODO_CRON_SECRET) return res.status(401).json({ error: "Invalid ARC TODO cron token." });
    try {
      res.json(await runReminderDispatch(pool));
    } catch (error) {
      console.error("ARC TODO reminder dispatch failed:", error.message);
      res.status(500).json({ error: "ARC TODO reminder dispatch failed." });
    }
  });
}

module.exports = { initArcTodoDB, seedArcTodoMembers, registerArcTodoRoutes };
