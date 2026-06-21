# Dogfood inbox (offline / no-`gh` fallback)

When `bin/je-issue.sh new` runs with `gh` unavailable (no network, unauthenticated, headless/cron,
rate-limited), it writes the finding here as a **committed** Markdown draft instead of silently
losing it. This directory is **tracked on purpose** — the fallback must never write to the gitignored
`.runs/`.

- Each draft is `INBOX-<UTC>-<pid>.md` with the same Problem / Durable evidence / Repro sections.
- **Commit the draft** so the finding survives.
- When `gh` is reachable again, run `bin/je-issue.sh drain-inbox`; it lists the drafts to re-file via
  `bin/je-issue.sh new …` (which re-validates evidence and dedups), then `git rm` each filed draft.

This is a **degradation mode of the one backlog**, not a second backlog. See
[`references/dogfood.md`](../../../skills/joust-engine/references/dogfood.md).
