# ARC TODO Focus V1 Implementation Plan

## Goal

Turn ARC TODO from a shared checklist into a cross-device personal planning and focus tool, without duplicating the existing task system. Phone PWA and browser remain the source of truth. A future native Mac companion will read the same focus APIs to provide the always-on-top reminder.

## Approved behaviour

- Tasks have a required planning date and optional scheduled start/end time.
- Each member has at most one current-priority task.
- A member can focus an open task they are assigned to or collaborate on.
- Starting focus records elapsed time only. Pausing or completing a focus session clears current priority; choosing the next priority is always deliberate.
- The administrator may see each member's current-priority title, but focus durations and session history remain private.
- The web UI stays Apple-minimal: one blue action colour, no streaks, scores, pressure-inducing countdowns, or dashboard clutter.

## Delivery steps

1. Extend ARC TODO's isolated schema with optional task schedule fields, current-focus state, and private focus-session history.
2. Add authenticated focus APIs: read current state/candidates, set or clear current priority, start a session, pause a session, and clear relevant focus state on task completion.
3. Add pure policy tests for focus eligibility and focus-session input validation, while preserving existing task tests.
4. Add a responsive Planner view (date-first, optional time blocks) and an inline Current Priority card with a deliberate candidate picker.
5. Refresh client data when the app regains focus, so phone and desktop converge without a second source of truth.
6. Verify unit tests, JavaScript syntax, clean Git diff, and desktop/mobile layout before requesting the user's deployment approval.

## Deferred to Focus V1.1

- Native Mac always-on-top companion window (Tauri); it will consume the APIs created here.
- Focus-history insights and calendar drag/drop.
- Google Calendar event enrichment for optional planned time blocks.
