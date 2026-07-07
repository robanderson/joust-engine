# Dogfood backlog — convention (GitHub Issues)

The dogfood backlog records problems (and feature-requests) we hit while running `@@JE`
tournaments, so they survive the **gitignored** `.runs/` directory and get triaged/fixed later.

**The live backlog is GitHub Issues**, labelled `dogfood` — the **single record** (issues are not
gitignored, so they are durable). All forge access is confined to one helper, `bin/je-issue.sh`
(plugin-root `bin/`, beside `je-git.sh`), so the tournament engine (`workflows/tournament.mjs`) stays
forge-agnostic. There is **no in-repo backlog or archive**; the only on-disk dogfood state is the
transient committed **inbox** used when `gh` is unreachable.

> **Why Issues** — they add dedup, search, `Closes #N` PR cross-linking, labels, and a triage UI,
> and they are not gitignored. The cost, accepted deliberately: the backlog no longer travels with a
> clone (you need `gh`/network to read it), and the GitHub API has **no compare-and-swap**, so a
> claim is best-effort, not a mutex (see *Claiming*). Mitigations: a committed offline **inbox** so a
> headless/no-`gh` run never loses a finding, and a git-ref **escape hatch** for strict exclusivity.
> Designed via an `@@JE` two-pass tournament (run `je-dogfood-vs-issues-20260615-050637`); the
> original design kept an in-repo archive, dropped here by choice in favour of Issues-as-sole-record.

## Where things live

| Thing | Location |
|---|---|
| Live backlog (open/claimed/closed, sev/area) | GitHub Issues, label `dogfood` |
| The capability (bootstrap / file / next / claim / drain-inbox) | `bin/je-issue.sh` |
| Issue form (structural evidence enforcement) | `.github/ISSUE_TEMPLATE/dogfood.yml` |
| This convention | `skills/joust-engine/references/dogfood.md` |
| Historical evidence (legacy `D-NNNN`) | the **closed** `dogfood` issues (full evidence in each body) |
| Offline drafts (committed, transient) | `docs/dogfood/inbox/` |

**Target repo (not hard-coded).** `bin/je-issue.sh` resolves the repo once per run: `$GH_REPO` if
set (`owner/repo`), otherwise inferred by `gh` from the current checkout's git remote, and every
issue/label call is pinned to it. Set `GH_REPO` to pin a target on a fork or a multi-remote checkout
where inference is ambiguous; otherwise the backlog simply follows whatever repo you're working in.

## Label scheme

- Marker: **`dogfood`** (every JE-filed item; the saved query keys off it).
- Severity: **`sev1`** (wrong winners / corrupts outcome) · **`sev2`** (degraded but usable) ·
  **`sev3`** (cosmetic/docs).
- Area: **`area:review` · `area:runner` · `area:parse` · `area:git` · `area:skill` · `area:docs` ·
  `area:infra`**.
- Claim state: **`claimed`** (transient). By-design closures carry **`wontfix`**.

Bootstrap once (idempotent, re-runnable): `bin/je-issue.sh bootstrap`.

## PUBLIC repo — what must never go in an issue

This repo is public, so an issue body is world-visible. **Forbidden:** secrets/tokens, and the
`mapping.json` **unblinding** line (which says which blind candidate was which model — it
de-anonymises a blind review). Refer to a candidate only as **"blind B"**. Enforced three ways:
the form's warning, `je-issue.sh`'s refusal greps (exit 4 = unblinding, 5 = secret), and the
migration scrub. The **verbatim-evidence** rule remains (it is required triage content), now
enforced structurally by the form's `required` field + the helper's empty/placeholder refusal
(exit 3) — not by convention alone.

### Privacy scrub (auto-filed issues)

Auto-filed RC issues (see *Recording a new issue*) run a **fail-closed scrubbing pass BEFORE** the
exit-3/4/5 guards (`je-issue.sh scrub-evidence`). It redacts, from the evidence excerpt, everything
that may never appear in a public issue:

- `$HOME` and usernames in paths → `<HOME>` / `<USER>`
- UPPER_SNAKE **env-var values** (`NAME=value`) → `NAME=<REDACTED>`
- `*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD`-shaped assignments → `<REDACTED>`
- RFC1918 **private IPs** (10.x, 172.16–31.x, 192.168.x) → `<PRIVATE-IP>` (public IPs are kept)
- `.local` / `.lan` **LAN hostnames** → `<LAN-HOST>`
- **email addresses** → `<EMAIL>`

It is **fail-closed**: any scrub error (or a still-refusing guard **after** scrub) **never posts or
drafts raw** evidence — it degrades to a scrubbed committed-inbox draft or a loud log. The scrub is
portable perl; volatile `$HOME`/`$USER` are passed via env and `quotemeta`'d so a metachar in either
cannot corrupt the pattern. The generic env-value class is scoped to UPPER_SNAKE names so useful
lowercase marker fields in `JOUST-*` excerpts (`endpoint=`, `exit=`, `max-turns=`) survive.

## Recording a new issue (human or tournament)

- **From an `@@JE` run (preferred):**
  ```
  bin/je-issue.sh new --sev sev2 --area parse \
     --title "<≤90 char one-liner>" \
     --evidence-file EV.md [--problem-file P.md --repro-file R.md --fix-file F.md --run-id <id>]
  ```
  Always pass a verbatim excerpt of the offending verdict/guidance as `--evidence-file`. The helper
  refuses empty/placeholder/unblinding/secret evidence and dedups before creating.
- **Auto-filed from an `@@JE` run.** At run end the engine files **one deduped issue per engine-fault
  RC class** (JE-RC 01/02 after retries, 04–09 — not honest model losses or the 03 turn-cap) to the
  engine repo, label `dogfood`, evidence = the `JOUST-RC` lines + `JOUST-*` marker excerpts only,
  privacy-scrubbed (above) and fail-closed. Pass the workflow arg `noAutoIssue: true` to disable it.
- **From a browser:** open an issue with the *Dogfood finding* template; required fields enforce the
  same minimum.

## Working an item (the `@@JE` dogfood-run flow)

1. **Pick** the top open item: `bin/je-issue.sh next` (walks `sev1 → sev2 → sev3`, lowest issue #).
2. **Claim** it: `bin/je-issue.sh claim <N> <run-id>` (best-effort — see below).
3. **Fix** on a feature branch `dogfood-<N>` (apply your configured branch-prefix rule, if any).
4. **Open one PR** with `Closes #<N>` in the body → merging auto-closes the issue and cross-links
   the PR. No manual roster edit. The closed issue + its PR are the permanent record.

## Claiming (best-effort, NOT a mutex)

The GitHub issue API has **no compare-and-swap**: `--add-assignee` / `--add-label` are
additive/idempotent, so two workers can both "succeed". `je-issue.sh claim` is therefore a **TOCTOU
best-effort** claim with read-after-write and a **deterministic tiebreak**: it adds you as assignee
+ `claimed` + a `claim:` comment carrying your run-id, then re-reads; if there are multiple
assignees, **the lowest-numbered `claim:` comment wins and only the loser releases** (livelock-free).
There is a sub-second residual window; for the normal 1–3-worker dogfood fan-out this is fine.

**Strict-exclusivity escape hatch (high fan-out / grand loops).** Use the original push-race
primitive, decoupled from the backlog and **never against `main`** — claim a git ref whose creation
is atomic on the server:
```
git push origin "$(git rev-parse HEAD):refs/dogfood-claims/D-<N>"   # NO --force
#   success  -> you own D-<N> (ref creation is atomic; existing ref is rejected non-ff)
#   rejected -> someone owns it; pick the next item
```
Release by deleting the ref. The issue still holds human-facing state; the ref is purely the lock.

**Staleness/TTL (2h).** A `claimed` issue whose latest `claim:` comment is older than 2h may be
reclaimed via the same protocol. Before closing, re-verify your `claim:` comment is still the
winning one — if a reclaim superseded you, bail without closing.

## Dedup

`je-issue.sh` matches a new item's title against existing open *and* closed `dogfood` issues before
creating; on a hit it points at the existing issue instead of filing a duplicate.

## Offline / headless / no-`gh` fallback

`gh` shares the "interactively-authed services may be absent in headless/cron runs" risk. On any gh
failure, `je-issue.sh new` **degrades to a committed draft** under `docs/dogfood/inbox/`
(**never** `.runs/`, which is gitignored — that would silently lose the finding). Commit it; when
`gh` is reachable, `bin/je-issue.sh drain-inbox` lists the drafts to re-file via `new` (then
`git rm`). The inbox is a **degradation mode of the one system**, not a parallel backlog.

## Historical items (legacy `D-NNNN` ids)

Before the migration, items were rostered in `DOGFOOD.md` with one evidence file per
item under `docs/dogfood/`. Those were imported as **closed** GitHub issues titled `[dogfood] D-NNNN: …`,
each carrying the **full original evidence/repro/resolution verbatim** in its body, and the in-repo
files were removed — the closed issues are the sole record now. Code comments that reference
`(dogfood D-NNNN)` map to those closed issues (search the title `D-NNNN`). New items use issue
numbers, not `D-NNNN` ids.

## Rollback

The migration is one PR: `git revert <merge-sha>` restores `DOGFOOD.md`, the README, and the
in-place `docs/dogfood/D-NNNN.md` evidence files (which the migration deleted), and removes the
helper/form. The imported closed issues are harmless to leave (closed, labelled `dogfood`); delete
them with
`gh issue list --label dogfood --state all --json number --jq '.[].number' | xargs -I{} gh issue delete {} --yes`
if a full reversal is wanted. No information is lost either direction — the reverted commit restores
the verbatim evidence files, and (until deleted) the closed issues hold the same evidence.

## Cross-run leaderboard ledger (`bin/je-ledger.mjs`)

Run outcomes die with the gitignored run dirs; the ledger makes them durable (issue #41).
After a run completes, `node bin/je-ledger.mjs record <runDir>` appends ONE JSON line to an
append-only ledger (`$JE_LEDGER_PATH`, default `~/.joust-engine/ledger.jsonl`) summarizing
the run's unblinded outcomes: mode/n, every seat (model, valid, failReason, round), winners
(round-1 / final / implement), `rc_summary.by_code`, and — when `timeline.jsonl` exists —
the per-phase **barrier** (slowest attempt) and mean attempt durations. The record's `ts` is
mapping.json's mtime (run completion), never the recording time; re-recording a run is a
skip, not a duplicate; missing optional inputs degrade gracefully.

`node bin/je-ledger.mjs report` aggregates the ledger to markdown: a per-model leaderboard
(seats, valid-rate, R1/final/implement wins, vetoes, mean attempt duration where a phase ran
a single model) plus the assumptions we track — two-pass value (fresh round-2 vs carried
round-1 finals), diversity (win distribution), and per-seat cost-vs-contribution. Every row
carries its sample size (`n=`); below n>=5 nothing is recommended, and at n>=5 findings are
phrased as hypotheses only. This is how diversity pools and default seats get tuned on
evidence.
