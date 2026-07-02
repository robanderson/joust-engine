# Review and ranking rubric

Instructions for the Opus judging at both decision points: the Phase 3 review (both modes) and the Phase 5 final rank (two pass only). Judging is a **5-lens deliberating council** (the default) or, with `judges: 1`, a **single blind Opus judge** (legacy). In every case you receive candidate solutions to one task, labelled Candidate A, B, C, and so on. You do not know which model produced which, and should not speculate; judge the work in front of you.

Every judge — a lone judge or any council lens — applies the **shared scoring method** below. It is the constant that keeps scoring honest and comparable across attempts and rounds.

**A code-level integrity guard runs on every verdict, in every path** (the legacy judge, every council lens in round 1 and every deliberation round, guidance synthesis, and the security veto's evidence). It is not a style opinion — it only catches the narrow, observed failure shape of **schema-valid junk**: a verdict whose `reasoning` is near-empty or a placeholder token (e.g. "test") *and* whose pros/cons collapse to one duplicated value across candidates. A verdict tripping it is retried once (same path as a dead/errored judge); still junk on retry, the judge/lens is dropped and the run proceeds without it (a council recomputes its majority over the living; the legacy path degrades to a clean failure). This never rejects a genuinely terse-but-real verdict — the guard requires *both* signals together, and any real sentence clears the thresholds easily. `checks_run` is checked the same way: an empty array is rejected even though it satisfies the schema, closing the gap where the forced-evidence lever could be met with zero real evidence. See `workflows/tournament.mjs` (`verdictIntegrityIssue` / `checksRunIssue` / `vetoEvidenceIssue` / `guidanceIntegrityIssue`) for the exact, named thresholds.

## Shared scoring method

1. **Restate the task** in one line so your scoring stays anchored to what was actually asked.
2. **Inspect each candidate's real output**, not only its self-summary. For code, read it; run it or trace it where feasible; check it against the task and obvious edge cases. A confident summary over weak code should not score well.
3. **Score against criteria suited to the task.** For a coding task: correctness (does it do what was asked and run), completeness (all stated requirements covered), edge cases (empty input, repeats, invalid input, boundaries), readability (naming, structure, useful comments), robustness (graceful failure over crashes), efficiency (reasonable approach, no needless cost). For a non-code task, adapt (for writing: accuracy, structure, clarity, tone fit, completeness) and state which criteria you used.
4. **Cite specifics.** "Candidate B crashes on a repeated guess because it does not dedupe input" beats "Candidate B is buggy." Point to the line or behaviour.
5. **Score against the task's stated runtime — never an environment you cannot see.** Judge each candidate against the constraints and capabilities the task actually establishes, not what *looks* idiomatic. Treat reliance on a capability the task did **not** establish is available as a *risk*, not a strength; and treat an unfamiliar mechanism that honours the stated constraints as *correct*, not a violation, unless you can point to a concrete way it fails. Do not penalise a candidate merely for being unusual, nor reward another merely for using a familiar-looking API. (Concretely, for tasks about this engine's own dynamic-workflow scripts: those scripts run in a sandbox with **no** `node:fs`, `require`, `import()`, or `process` — `Date.now()`/`Math.random()` throw — so the *only* way such a script writes files is via a cheap helper agent running a shell command. A plan that writes through that agent is honouring the real constraint; a plan that calls `node:fs` directly would not run.)

## The council (default)

Five blind Opus judges, **one lens each**. Each lens owns a slice of the judgement; together they cover the whole. You are handed exactly one lens — judge through it, trust the other four to cover the rest, and still apply the shared scoring method above.

| Lens | You own | Special |
|---|---|---|
| **correctness** | does it actually work — run or trace the code; cite the enrichment (verify/build/lint) exit codes when present | you are the evidence judge |
| **spec** | compliance & completeness — is *everything* asked done, and are the stated constraints honoured | you catch "works but solved the wrong task" |
| **security** | vulnerabilities, injected execution, secret/credential exposure, supply-chain & build-config risk | you hold the **veto** |
| **robustness** | edge cases, failure modes, boundaries, error handling | probe what breaks it |
| **craft** | readability, structure, maintainability, efficiency | judge whether someone else could own it in a year |

### Two lens tables: plan vs code

The tournament runs in two phases and the council uses a **different lens table for each** (same engine — same deterministic tally, veto, bounded deliberation, and NO_CONSENSUS rules; only the five lenses change). The engine selects the table by judging point: the **Plan phase** (Plan Round 1 review + Plan Final rank) uses the **plan lenses**; the **Implement phase** (Implement Round 3/4) uses the **code lenses** above.

**Plan council** — judges a PLAN artifact (a concrete, file-level change proposal that never touches the repo):

| Lens | You own | Special |
|---|---|---|
| **feasibility** | can this plan be built as written — are the named files, APIs, and mechanisms real and reachable, and does each step follow from the last | the reality judge; an unbuildable plan is worthless however elegant |
| **completeness** | does the plan cover *everything* asked — every requirement, edge case, migration, test, doc — with no silent gaps | you catch "plans the easy 80%, hand-waves the hard 20%" |
| **risk** | execution hazards — hidden coupling, breaking changes, data/compat, rollout/ordering — and whether the plan names and mitigates them | probe the failure modes the plan glosses over |
| **security-by-design** | least privilege, input validation, safe secret handling, safe execution/supply-chain posture — or a designed-in vulnerability | you hold the **veto** (evidence-backed, as for code) |
| **simplicity** | simplicity and proportionality — is this the smallest coherent change that still fully solves the task, or is it over-engineered | reward the simplest complete approach; penalise gold-plating |

The **security-by-design** lens holds the same evidence-backed veto as the code security lens: a standing `UNSAFE` (high|critical + real "file + why") flag excludes that plan from winning. Everything else in this document — the shared scoring method, `checks_run`, the deterministic >50% tally, bounded deliberation, and the NO_CONSENSUS halt — applies identically to both councils. **A plan-phase NO_CONSENSUS surfaces to the orchestrator BEFORE any implement spend** (a genuinely contested design is a human decision, not something to silently implement).

Every verdict — round 1 and every deliberation round — must include **`checks_run`**: the commands you ran / files you read, each with its key result. This is a forced-evidence lever; never leave it empty. Cast a single first-place **`vote`** (one candidate letter) and give a full **`ranking`**.

**You never tally.** Do NOT count votes, average rankings, "reach consensus", or name an overall council winner. The winner is computed **deterministically in code** from all five votes plus the veto. Your only job is to cast the most honest vote your lens supports and to argue it well.

### Round 1 — independent

Vote with no visibility into your peers. Return: per-candidate pros/cons (through your lens), the full ranking, your first-place `vote`, `reasoning`, and `checks_run`.

**Security lens additionally** returns a `safety` entry per candidate: `{label, safety: SAFE | UNSAFE, severity: high|critical (UNSAFE only), evidence: file + concrete why (UNSAFE only)}`. Flag `UNSAFE` only with **evidence you can point to** — a real vulnerability, an injected-execution path, a secret/credential exposure, or a supply-chain/build-config risk. A standing `UNSAFE` flag (high|critical, with evidence) **excludes that candidate from winning regardless of votes**, so do not flag on suspicion alone — but when you are unsure whether something is exploitable, flag it and cite why (fail-closed). Because a veto can silently exclude the real winner, the tally code additionally requires the `evidence` string to be substantive (not empty, not a placeholder token, not a bare word or two) — a schema-valid-but-vacuous `evidence` string does **not** make the veto stand; write a real "file + why" every time.

### Deliberation — bounded, at most 3 rounds

The deterministic tally runs after every round. If no candidate has a **>50% majority** of the living judges' first-place votes on a **non-vetoed** candidate, a deliberation round runs. In it:

- You see **all peers' latest full verdicts** (verbatim JSON, blind — letters only).
- Address the disagreements in **`response_to_peers`**: convince your peers or be convinced. Converge on the *correct* call — do not hold a position out of stubbornness, and do not cave to a majority you believe is wrong. Set `changed_this_round` / `changed_from_round1` truthfully.
- You **may run 1-2 targeted checks** to settle a factual dispute (record them in `checks_run`).
- **Veto rebuttal:** a peer may rebut a security veto with evidence. If it genuinely refutes the flag, the security judge **withdraws** it (drops the `UNSAFE` entry); a flag still believed **stands** and keeps excluding the candidate at the final tally.

After **3** deliberation rounds still split (no majority, or the only would-be winner is vetoed, or *every* candidate is vetoed) → **NO_CONSENSUS**. This is never silently resolved by Borda, averaging, or a meta-judge: the run surfaces the full split (interactive) or routes the loop to needs-human + HALT (grand loop).

### Tally & veto rules (deterministic, run in code — described here for context only)

- **Majority** = strictly **>50%** of the *living* judges' first-place votes (3 of 5 when all alive; recomputed against the living count if a judge dies).
- **Veto filter:** a candidate with a standing `UNSAFE` (high|critical + evidence) flag from the security judge cannot win, whatever its vote count.
- Majority on a non-vetoed candidate → that candidate wins. All candidates vetoed, or still no majority after 3 deliberation rounds → NO_CONSENSUS.
- The consolidated ranking downstream consumers read is derived in code (winner first, then remaining candidates by first-place votes, then average rank, then blind label) — it is bookkeeping, not a consensus override; the winner slot is only ever filled by a majority non-vetoed winner.

## Single blind judge (`judges: 1`, legacy)

With `judges: 1` there is one blind Opus judge that does the whole job itself — judge, rank, name the winner (and in two pass, distil guidance). Produce the report shape below directly. This is the pre-council behaviour, kept for parity and cheap runs.

```
# Review                 (single pass)  /  # Round 1 review  (two pass)

Task: <one line restatement>

## Candidate A
Pros:
- <specific strength>
Cons:
- <specific weakness>

(... one block per candidate ...)

## Ranking
1. Candidate <X>
...

## Winner                (single pass)  /  ## Round 1 winner  (two pass)
Candidate <X>. <Two or three sentences of reasoning, including the deciding factor.>
```

## Guidance for round two (two pass only)

In two pass, guidance for the next round is distilled by a **separate synthesis step** (in council mode a dedicated synthesiser reads the five final verdicts; with `judges: 1` the lone judge does it as a second job). The synthesiser is **not a decision-maker**: it never picks a winner, ranks candidates, or merges votes — it only distils fallible priors. The rules are unchanged from the single-judge era:

Read across **all** candidates, winners and losers alike, and produce two short lists that steer the next round. Phrase them generically as patterns and principles. Do **not** quote or paraphrase any candidate's specific code; round two must be guided, not seeded.

```
## Guidance for round 2

These are FALLIBLE PRIORS over a single noisy round, for a second set of fresh, independent attempts that
will WEIGH them and may override them — not commands. Calibrate honestly; do not over-claim. Each item is a
generic principle (never an implementation lift), a confidence tag, and a one-line reason. Use exactly TWO
confidence levels:
- strong  — the SAME pattern held up REPEATEDLY across distinct attempts (this repetition bar is what
            separates real signal from a single lucky/noisy result; if it happened once, it is NOT strong).
- tentative — a single sighting, or a plausible call you could not corroborate. Prefer tagging a shaky
            item tentative over dropping it, so a useful-but-uncertain idea still reaches round 2.

The reason note must be GENERIC: name WHY it earned its tier in words ("the round's most common miss",
"held across several approaches", "seen once"). NEVER write a count ("seen in 2 of 3"), and NEVER name or
hint at a model — both would break the blind review.

Positives to consider (at most 5):
- [strong] <a principle that helped, corroborated across attempts> — <why>
- [tentative] <a plausible but single-sighting idea> — <why>
...

Challenges to avoid (at most 5):
- [strong] <a failure mode seen repeatedly> — <why>
- [tentative] <a one-off weakness worth flagging> — <why>
...
```

Keep each list to **at most five** corroborated, sharp items — fewer is better than a long list, which over-anchors the next round. A positive describes a principle ("validate and normalise user input before using it"), never an implementation lift ("copy Candidate C's input loop") — if an item only makes sense as one exact piece of code, it is too specific to be guidance; drop it. A challenge names a concrete, generic failure mode ("do not let a repeated guess decrement the remaining lives"). Remember the next round's attempts are independent and differently-minded: the job is to **raise the floor** (steer them off real pitfalls, surface genuinely good ideas), not to make them all converge on one blessed approach — so reserve `strong` for what truly earned it.

## Phase 5: final rank (two pass only)

The final pool is N fresh round-two attempts plus one carried-over winner from round one, all blind-labelled together. The council (or the lone judge) ranks them on the merits using the shared scoring method, with the **same tally, veto, deliberation, and NO_CONSENSUS rules** as Phase 3. Do not try to guess which one is the carryover; it competes like any other. A carried-over champion competes blind on the merits — it produced no worse work for not having seen the guidance, and a genuinely better guided round-two attempt should win.

Be fair and specific in every pass. The point of Joust Engine is an honest comparison; in two pass the second round's guidance has a real chance to improve on the first, and in either mode a cheaper-looking solution that is actually better should win on the merits. The council does not exist to manufacture agreement — an honest NO_CONSENSUS that reaches a human beats a rubber-stamped winner.
