# Joust Engine — Dogfood Backlog

**The live dogfood backlog has moved to GitHub Issues** (label `dogfood`; list with
`gh issue list --label dogfood --state all`, or open the repo's Issues tab filtered by that label).
This file is a stub kept as a discoverable pointer; it is no longer the roster.

- **Live backlog:** `gh issue list --label dogfood --state all` (or the link above).
- **File / claim / work an item:** `bin/je-issue.sh` (see below).
- **Convention + flow:** [`skills/joust-engine/references/dogfood.md`](skills/joust-engine/references/dogfood.md).
- **Historical items (legacy `D-NNNN`):** imported as **closed** `[dogfood] D-NNNN:` issues, each
  carrying the full original evidence/repro/resolution verbatim in its body (search the `dogfood`
  label). The old in-repo `docs/dogfood/archive/` was removed — Issues are the sole record.

```bash
bin/je-issue.sh bootstrap                 # (once) create the dogfood label scheme
bin/je-issue.sh new --sev sev2 --area parse --title "…" --evidence-file EV.md
bin/je-issue.sh next                       # top open item (sev1 → sev3)
bin/je-issue.sh claim <N> <run-id>         # best-effort claim (see convention doc)
# fix on a rob/dogfood-<N> branch, open one PR with "Closes #<N>"
```

> Migrated from the Markdown roster via the `@@JE` two-pass tournament
> `je-dogfood-vs-issues-20260615-050637` (HYBRID design; the in-repo archive it proposed was dropped
> by choice — Issues are the sole record, with a committed inbox for offline durability). To roll
> back: `git revert` the migration PR.
