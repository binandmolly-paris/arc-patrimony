# ARC TODO Implementation Plan

> **For Codex:** Implement and verify this plan task-by-task. Do not deploy, configure cloud credentials, transmit a task, or migrate browser data until the production authorization checklist is complete.

**Goal:** Deliver an Apple-inspired, minimal ARC TODO PWA backed by isolated Render/PostgreSQL routes, with secure Google login, calendar/email delivery hooks, reminder scheduling, and a safe import path for the user’s current local tasks.

**Architecture:** ARC TODO is a modular sibling of the investment app, mounted at `/arc-todo/` and `/api/arc-todo/*`. It has its own tables, allow-listed member identities, HttpOnly session cookie, and cron secret; its database queries and credentials are intentionally unable to access investment data. The PWA works as a polished client once authenticated and imports the previous file-based prototype via an explicit JSON backup instead of attempting cross-origin localStorage access.

**Tech Stack:** Node 18, Express, PostgreSQL, `googleapis`, browser-native PWA APIs, vanilla HTML/CSS/JavaScript, `node:test`.

---

## Approved product and security rules

- Product name: **ARC TODO**. Visual language: Apple-like restraint — white space, monochrome hierarchy, one blue action colour, rounded geometry, native-feeling motion.
- Family roles: LIU BIN is `admin`; Molly and Yukun are `member`. All can create/reassign/complete tasks. Admin sees all tasks; a member sees only tasks created by, assigned to, or shared with that member.
- Task reminders: one pre-due reminder (default: 24 hours before), one on the due date, one at `due + 3 days`; no daily nagging. Each checkpoint is App + dedicated Google Calendar + email.
- No real recipient email, student number, secrets, refresh token, or password is committed in source. Render environment variables hold deployed identities and credentials.
- Existing local data remains untouched. The legacy browser app gets an export action; ARC TODO imports a user-selected JSON file only after the user signs in.

## Task 1: Preserve existing local tasks and rename the prototype

**Files:**
- Modify: `/Users/liubin/Library/CloudStorage/GoogleDrive-binandmolly@gmail.com/我的云端硬盘/管家婆/index.html`
- Modify: `/Users/liubin/Library/CloudStorage/GoogleDrive-binandmolly@gmail.com/我的云端硬盘/管家婆/app.js`
- Modify: `/Users/liubin/Library/CloudStorage/GoogleDrive-binandmolly@gmail.com/我的云端硬盘/管家婆/manifest.webmanifest`

**Steps:**
1. Rename visual/app metadata to ARC TODO without changing `localStorage` key.
2. Add explicit JSON export with task count and timestamp.
3. Verify an existing browser task is not cleared by reload and an exported file has the expected envelope.

## Task 2: Add isolated database model and pure policy tests

**Files:**
- Create: `arc-todo-core.js`
- Create: `test/arc-todo-core.test.js`
- Create: `arc-todo-routes.js`
- Modify: `server.js`

**Steps:**
1. Write failing Node tests for email normalization, role visibility, task import normalization, and the three reminder checkpoints.
2. Implement pure functions in `arc-todo-core.js`; run `node --test` to verify.
3. Add `arc_todo_members`, `arc_todo_tasks`, `arc_todo_collaborators`, `arc_todo_activity`, `arc_todo_sessions`, OAuth-state, and notification-log tables with indexes and no foreign keys to investment tables.
4. Mount a dedicated route module only after database initialization; provide `GET /health` that discloses configuration state but no secret.

## Task 3: Implement Google identity and task APIs

**Files:**
- Create: `arc-todo-auth.js`
- Modify: `arc-todo-routes.js`
- Test: `test/arc-todo-core.test.js`

**Steps:**
1. Implement OAuth state records, callback validation, ID token verification, email allow-list, secure session hashing, and logout.
2. Implement `/me`, `/members`, task list/create/update/complete/import endpoints using the independent cookie session.
3. Enforce SQL-side/member-side visibility checks for every task action.
4. Verify unauthenticated requests return 401; unknown Google email returns 403; a member’s task query cannot return unrelated records.

## Task 4: Build Apple-style ARC TODO PWA

**Files:**
- Create: `public/arc-todo/index.html`
- Create: `public/arc-todo/styles.css`
- Create: `public/arc-todo/app.js`
- Create: `public/arc-todo/manifest.webmanifest`
- Create: `public/arc-todo/sw.js`
- Create: `public/arc-todo/icon.svg`

**Steps:**
1. Build login, Today, Inbox, assigned, completed, create/edit, and import/export views.
2. Use server API as source of truth; display only members’ names, never email addresses.
3. Provide narrow-screen mobile interaction and install metadata.
4. Verify desktop and mobile layouts, keyboard focus, empty/error/loading states, and task lifecycle.

## Task 5: Add calendar/email integration and scheduler (configuration-gated)

**Files:**
- Create: `arc-todo-notify.js`
- Modify: `arc-todo-routes.js`
- Create: `docs/ARC_TODO_RENDER_SETUP.md`

**Steps:**
1. Use a dedicated Google OAuth refresh token with `calendar.events` and `gmail.send` only; do not reuse the Drive token.
2. Create/update events only in `ARC_TODO_CALENDAR_ID`; add the task assignee as an attendee.
3. Send branded ARC TODO email notices and write a channel/checkpoint notification log after success.
4. Add `/api/arc-todo/cron/reminders`, authenticated only by `ARC_TODO_CRON_SECRET`; deduplicate each task/checkpoint/channel.
5. Document Render variables, Google Cloud consent screen, cron-job configuration, low-risk first run, rollback, and no-password rule.

## Task 6: Production handoff (requires explicit user action)

**Steps:**
1. Create a dedicated ARC TODO Google account/alias or configure a verified Gmail sender identity; name it `ARC TODO`.
2. Create Google OAuth Web Application credentials and authorize only the stated scopes.
3. Set the `ARC_TODO_*` Render variables; do not reuse investment secrets.
4. Deploy via the existing source repository/Render flow, then sign in as each of the three users.
5. Export the legacy browser tasks and import them under LIU BIN; test a harmless task end-to-end before enabling recurring reminders.

## Verification and acceptance

- `/arc-todo/` cannot fetch investment API data and uses a distinct cookie namespace.
- Admin sees all tasks; member visibility is limited exactly as approved.
- Email/calendar actions state clearly whether service credentials are connected; nothing is falsely marked sent.
- Existing local tasks can be exported before any migration.
- No secret or family email appears in `public/`, committed docs, test fixtures, or browser responses.
