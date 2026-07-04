# LLM-as-a-Judge for Agentic Workflows — State of the Art

> Research report for [issue #22](https://github.com/robanderson/joust-engine/issues/22).
> Compiled June 2026. Scope: how leading labs and the research community build "LLM as a
> judge" systems, with concrete recommendations for the **Joust Engine** — a best-of-N
> tournament that runs N parallel single-pass attempts and uses a fixed **blind Opus**
> reviewer to score, rank, and crown a winner.

## How this was researched

The bulk of the claims below come from a multi-agent deep-research pass: ~100 search/fetch
agents fanned out over the question, extracted falsifiable claims, and each claim was put
through **3-vote adversarial verification** (a claim survives only if it is *not* refuted by
≥2 of 3 skeptical voters reading the primary source). Findings are tagged with their vote
(e.g. `3-0`) and confidence. A handful of brief topics produced no surviving verified claim
in that pass (OpenAI RFT graders, Prometheus, FLAMe, RLVR specifics, PRMs); those are
filled in from direct web search and are explicitly marked **[supplementary, lighter
verification]** so the evidentiary weight is honest.

> ⚠️ **Access caveat.** `arxiv.org`, `anthropic.com`, and Google Cloud docs returned HTTP
> 403 to direct fetches through the environment proxy. Verification leaned on search
> snippets that reproduced primary-source text plus official mirrors (GitHub, HuggingFace,
> the Qwen blog). Quotes are corroborated across multiple independent retrievals but were
> not always read first-hand from the canonical PDF.

---

## TL;DR for the Joust Engine

1. **Go hybrid.** State-of-the-art practice converges on **cheap deterministic verifiers as
   a gate** (JSON valid, schema match, code runs, tests pass, exact match, tool-call/state
   checks) **+ an LLM judge for the subjective remainder**. Anthropic, OpenAI, Google, and
   the agent-benchmark world (τ²-bench, SWE-bench) all do this. Don't spend Opus tokens
   judging a candidate that fails `JSON.parse`.
2. **Grade the outcome, not the path** — Anthropic's explicit guidance for agent evals.
   Joust already does this (single-pass attempts, judge the artifact). Keep trajectories for
   *diagnostics*, not for scoring.
3. **One isolated judge per dimension, each with a rubric** — also Anthropic's explicit
   recommendation. This directly validates the issue's 5-score design (Format, Factuality,
   Consistency, Realism, Quality). Don't ask one prompt to score all five at once.
4. **The blind label is doing real work.** Self-preference / self-enhancement bias is
   measurable and significant in frontier judges; blind labeling, position-swapping, and
   (optionally) a disjoint-family jury are the canonical defenses. Joust's blind labeling is
   the single most important bias control it already has.
5. **Watch position bias in tight tournaments.** Position bias is *worst exactly when
   candidates are close in quality* — which is the common case in a good tournament. Mitigate
   by randomizing candidate order per judge call and, where feasible, swapping.
6. **Validate the judge against humans** before trusting it to pick winners autonomously.
   The field's standard agreement metric is **Cohen's κ** (plus accuracy/F1, or
   Spearman/Pearson for scores).

---

## 1. Core concepts & taxonomy

The comprehensive **LLMs-as-Judges survey** (Li, Dong, Chen et al., Dec 2024,
[arXiv:2412.05579](https://arxiv.org/abs/2412.05579)) organizes the field along **two
orthogonal axes** — keep them distinct rather than collapsing them into one taxonomy
*(verified 2-1)*:

**Axis A — system architecture**
- **Single-LLM judge** (prompt-, tuning-, or post-processing-based variants). One model
  scores. Cheapest; most exposed to that model's idiosyncratic biases.
- **Multi-LLM** — *cooperation* (juries/panels that aggregate) or *competition* (debate,
  peer review) with an aggregation strategy (majority vote, average pooling).
- **Human–AI hybrid** — model does the bulk, humans calibrate/audit.

**Axis B — evaluation paradigm**
- **Pointwise / absolute** — score each candidate independently against a rubric (e.g.
  0–10, or per-dimension sub-scores). Scales to N candidates linearly; comparable across
  runs; the natural fit for *rubric* scoring.
- **Pairwise** — show two candidates, pick the better (or a preference + margin). Higher
  human agreement on close calls, but **O(N²)** for a full ranking and exposed to
  **position bias**.
- **Listwise** — rank the whole list in one shot. Cheapest for ranking; most exposed to
  position/primacy effects across a long list.

Other foundational distinctions:
- **Reference-based vs reference-free.** With a gold answer you can do exact/semantic
  match; without one (the Joust case for open-ended tasks) the judge works *reference-free*
  against criteria.
- **Generative reward model / "reward model as judge."** Modern reward models are often
  *generative* — they produce a rationale then a score — blurring the line between an
  RLHF reward model and an LLM judge. The same model architecture serves training-time
  reward and eval-time judging.

**Foundational pattern — G-Eval** (Liu et al., EMNLP 2023,
[arXiv:2303.16634](https://arxiv.org/abs/2303.16634)) established the dominant *pointwise*
design: **LLM + chain-of-thought + a form-filling paradigm** to score an output against
criteria. GPT-4-backed G-Eval hit **Spearman 0.514** with humans on summarization,
"outperforming all previous methods by a large margin" vs BLEU/ROUGE/BERTScore/BLEURT
*(verified 3-0)*. Notably, the G-Eval paper itself flagged "the potential issue of LLM-based
evaluators having a bias towards LLM-generated texts" — an early self-preference warning.
*(2023 result; superseded in absolute quality by 2026, but the CoT-+-form-filling pattern is
still the backbone.)*

---

## 2. The five quality-score dimensions

The issue proposes five LLM-judged scores. Each maps cleanly onto an established
measurement tradition. **Score each with its own isolated judge call and an explicit
rubric** (Anthropic's recommendation, §4).

| Dimension | What it measures | How the field measures it |
|---|---|---|
| **Format** | Structure & schema adherence | Best done **deterministically first** (JSON validity, schema/`response_format` match, regex/constraint checks). OpenAI structured outputs and JSON-schema validators turn this into a pass/fail gate. Reserve the LLM only for "is the structure *appropriate*" judgments a validator can't express. |
| **Factuality** | Groundedness / faithfulness; hallucination | Decompose claims and check each against a source. Anthropic's research-agent rubric uses **groundedness** ("are claims supported by retrieved sources?") and **citation accuracy**. RAGAS/DeepEval operationalize *faithfulness* and *answer-relevancy* the same way. For code, "factuality" ≈ does it actually do what it claims (cross-check summary vs behavior). |
| **Consistency** | Internal non-contradiction; self-consistency | NLI-style contradiction detection within the output; **self-consistency** sampling (Wang et al.) — sample multiple judge rationales and check they agree. G-Eval's "consistency" criterion on SummEval is the canonical pointwise instance. |
| **Realism** | Believability / plausibility | Closest to a *quality/coherence* judgment; measured by rubric-guided LLM scoring of plausibility, and in agent settings by checking outputs against a **world model / real environment** (Qwen AgentWorld, §5 — does the predicted state match what really happens?). |
| **Quality** | Overall craft | The classic open-ended LLM-judge target (MT-Bench's single-answer grading on a 1–10 scale). For code: correctness, readability, robustness, efficiency — exactly the Joust rubric's existing criteria. |

**Design note for Joust.** Anthropic's multi-agent research system found that a **single LLM
call outputting a 0.0–1.0 score plus a pass/fail per rubric dimension** was "the most
consistent and aligned with human judgements" for their use — i.e. structured numeric +
binary, not free prose. The 5-score design should emit a number *and* a one-line cited
justification per dimension.

---

## 3. Rules-based / programmatic verifiers (the deterministic gate)

The issue's "Rule Checks" list — **JSON valid, code runs, schema match, tests pass, exact
match** — is exactly the **RLVR** (Reinforcement Learning with Verifiable Rewards) family of
signals, and the consensus is that these should run *before* and *alongside* the LLM judge.

- **Why deterministic first.** Rule-based verifiers give a "direct, bias-free objective
  connection to ground truth" and are **resistant to reward hacking**, unlike a learned or
  LLM judge that can be gamed. They're cheap, reproducible, and fast. **[supplementary]**
- **Anthropic's framing** *(verified 3-0,
  [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents))*:
  three grader types — **code-based**, **model-based**, **human**. Code-based graders are
  "fast, cheap, and reproducible" and "brittle to valid variations but objective," ideal for
  **unit tests, state verification, and tool-call validation** (string match, static
  analysis/linting, SQL state checks). Model-based graders are "necessary for nuance" via
  "LLM-as-a-Judge with specific rubrics." **This is the primary-source basis for the Joust
  hybrid gate.**
- **OpenAI's grader taxonomy** (Reinforcement Fine-Tuning / Evals API) **[supplementary]**:
  - `string_check` — `eq` / `ne` / `like` / `ilike` (exact & fuzzy literal match), executed
    locally in the loop (cheapest).
  - `text_similarity` — `cosine`, `fuzzy_match`, `bleu`, `gleu`, `meteor`, `rouge_*`.
  - `score_model` — an **LLM grader** that assigns a numeric score (this is OpenAI's
    "LLM-as-judge" primitive). Combinable via a `multi`/Python grader.
  - These integrate directly with the Evals product; each RFT validation step becomes an
    eval run. *(OpenAI has signaled deprecation/migration of some grader surfaces into the
    newer evals workflow — mechanism stable, branding in flux.)*
- **Execution-based code eval** (SWE-bench, HumanEval-style): the verifier *runs the code
  against tests*. For Joust coding tasks, "code runs / tests pass" is the single highest-signal
  gate and the rubric already says to run candidates "where feasible."

**The pattern: gate, then judge.**

```
candidate ──▶ [ deterministic verifiers ]
                 JSON.parse ok? schema match? compiles? tests pass? exact match?
                      │ fail
                      ▼
               hard-fail / heavy penalty  (cheap, no judge tokens spent)
                      │ pass
                      ▼
              [ LLM judge: 5 rubric dimensions ]  →  scores + rationale
```

This keeps the expensive Opus pass focused on the candidates that clear the objective bar,
and prevents a fluent-but-broken candidate from charming the judge.

---

## 4. What the leading labs do

### Anthropic *(directly applicable — Joust's judge is Opus)*

- **Grade outcomes, not paths** *(verified 3-0)*. "It's often better to grade what the agent
  produced, not the path it took," because step-sequence checks yield "overly brittle tests,
  as agents regularly find valid approaches eval designers didn't anticipate" and "punish
  creativity." Trajectories are still kept to *diagnose* regressions/loops. → Joust's
  single-pass-judge-the-artifact model is exactly right; keep transcripts only for debugging.
- **Isolated judge per dimension + rubric + human calibration** *(verified 3-0)*. "Create
  clear, structured rubrics to grade each dimension of a task, and then grade each dimension
  with an isolated LLM-as-judge rather than using one to grade all dimensions," and
  "LLM-as-judge graders should be closely calibrated with human experts." → Direct mandate
  for the 5-score design, each scored separately.
- **Hybrid graders** *(verified 3-0)* — see §3.
- **Statistical rigor** *(verified 3-0,
  [statistical approach to model evals](https://www.anthropic.com/research/statistical-approach-to-model-evals),
  [arXiv:2411.00640](https://arxiv.org/abs/2411.00640))*. Two results matter for a tournament:
  - **Cluster standard errors** on the unit of randomization when questions are
    non-independent — naive CLT "will lead to underestimating the standard error," and
    "clustered standard errors can be over 3× larger than naive."
  - **Use question-level paired differences** when comparing two models — a "free" variance
    reduction, valid because frontier-model per-question scores correlate ~0.3–0.7.
  → For best-of-N winner selection, paired/clustered analysis guards against
  over-confident crowning when candidates are statistically tied.
- **Real-world rubric** (multi-agent research system): factual accuracy, citation accuracy,
  completeness, source quality, tool efficiency — scored in a single 0.0–1.0 + pass/fail call.
- **Constitutional AI / RLAIF** **[supplementary, not separately verified here]**: Anthropic's
  RLAIF lineage is the original "model judges model against a written constitution/principles"
  system — the conceptual ancestor of rubric-based LLM judging. Treat the specifics as
  needing a direct read before relying on them.

### OpenAI **[supplementary]**

- **OpenAI Evals** — open framework; **model-graded evals** (an LLM grades another model's
  output against a prompt/rubric) were one of the earliest productized LLM-as-judge patterns.
- **GPT-4-as-judge** was the de-facto strong judge in the MT-Bench era and most early
  academic work.
- **RFT graders** — see §3 (`string_check`, `text_similarity`, `score_model`, multi/Python).
- **simple-evals** — OpenAI's lightweight, mostly exact-match/deterministic eval suite,
  illustrating the "deterministic where possible" philosophy.
- **Structured Outputs** (JSON-schema-constrained decoding) — turns the *Format* dimension
  into a near-guaranteed pass and is the recommended way to make a judge emit machine-readable
  verdicts.

### Google / DeepMind

- **Vertex AI AutoSxS** *(verified 3-0,
  [docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/side-by-side-eval))* —
  a production **pairwise** LLM-judge: a third **autorater** compares two responses by
  criteria. Two features worth copying:
  - **Response-flipping** for position-bias control: "half of the calls to the judge model
    flips the baseline and candidate response to reduce judge model bias."
  - **Autorater validation against humans**: when human-preference data is supplied it reports
    win rates plus **accuracy, precision, recall, F1, and Cohen's κ**. *(By mid-2026 AutoSxS
    has been folded into the broader Gen AI Evaluation Service with SDK deprecations —
    mechanism accurate, product surface evolving.)*
- **FLAMe** (Foundational Autorater Models, [arXiv:2407.10817](https://arxiv.org/abs/2407.10817))
  **[supplementary]** — a family of autoraters trained on 5M+ human judgments across 100+
  quality-assessment tasks; reported to beat GPT-4/Claude-3 on many held-out eval tasks. The
  "train a dedicated evaluator model" school.

### Academic & open-source evaluators **[mostly supplementary]**

- **MT-Bench / Chatbot Arena** (LMSYS, Zheng et al. 2023) — introduced LLM-as-judge to the
  mainstream and *first catalogued its biases* (position, verbosity, self-enhancement).
  Single-answer grading (1–10) and pairwise both supported; Arena = crowd Elo.
- **G-Eval** — §1 *(verified 3-0)*.
- **Prometheus 1 / 2** (prometheus-eval) — **open** evaluator LMs fine-tuned for fine-grained
  rubric scoring. Prometheus-13B reached **Pearson 0.897** with humans across 45 custom
  rubrics, on par with GPT-4 (0.882) and far above ChatGPT (0.392). Prometheus 2 (7B/8x7B)
  does both absolute and pairwise. The case that you don't need a closed frontier model to
  judge well. **[supplementary]**
- **Cohere "Replacing Judges with Juries" — PoLL** (Verga et al. 2024,
  [arXiv:2404.18796](https://arxiv.org/abs/2404.18796)) *(verified 3-0)*. A **Panel of LLM
  evaluators** (e.g. {Command R, Haiku, GPT-3.5}) **outperforms a single large judge**,
  "exhibits less intra-model bias due to its composition of disjoint model families," and is
  "over seven times less expensive." On KILT NQ, PoLL κ=0.763 beat GPT-4 (0.627). *Caveat: a
  2026 critique ("Nine Judges, Two Effective Votes") notes panels beat the **average**
  individual judge and that **correlated errors** cap real gains — a qualification, not a
  refutation.*
- **RewardBench / JudgeBench** **[supplementary]** — benchmarks for *the judges/reward models
  themselves*; the right tools to pick or validate a judge.
- **Tooling**: RAGAS, DeepEval, Braintrust, Langfuse, Arize Phoenix — productized LLM-judge
  metrics (faithfulness, relevancy, correctness) with human-label calibration loops.

---

## 5. Qwen AgentWorld (the talk in the issue)

The [YouTube talk](https://youtu.be/VzmMQWRhlBw) corresponds to **Qwen-AgentWorld: Language
World Models for General Agents** (Qwen Team, 2026-06-24,
[arXiv:2606.24597](https://arxiv.org/abs/2606.24597),
[blog](https://qwen.ai/blog?id=qwen-agentworld),
[GitHub](https://github.com/QwenLM/Qwen-AgentWorld),
[dataset](https://huggingface.co/datasets/Qwen/AgentWorldBench)) *(verified 2-1, medium
confidence — days old at time of writing)*.

- **Language world model (LWM).** Instead of judging an agent by hand-written checks, Qwen
  trains a model to **simulate the environment** the agent acts in: given the current state
  and an agent action, it predicts the next observation by reasoning through environment
  dynamics in long chain-of-thought
  (`Current State → Agent Action → Reasoning → Predicted Environment State`). Trained on
  **10M+ real-world environment interactions**.
- **AgentWorldBench.** A trajectory-evaluation benchmark **constructed from real environment
  interactions of frontier models (including Claude Opus 4.6)** on established agent
  benchmarks (Terminal-Bench 1.0/2.0, OSWorld-Verified), spanning **seven domains**: MCP,
  Search, Terminal, Software Engineering, Android, Web, OS. Predicted observations are scored
  against **paired ground-truth observations from the real environment**.
- **Why it matters for Joust.** It's the mid-2026 signal of where *agent-trajectory* judging
  is heading: rather than an LLM opining on whether a multi-step run "looks good," you check
  predicted/actual **environment state** — a learned, scalable cousin of the deterministic
  state-checks in τ²-bench (§7). For Joust, the takeaway is *prefer grounding Realism/Factuality
  in observable outcomes over pure judge opinion wherever an environment exists to check
  against.*

---

## 6. Failure modes & biases (and mitigations)

These are the reasons a naive judge is untrustworthy — and why Joust's blind, fixed-judge
design already mitigates several.

| Bias | What happens | Mitigation |
|---|---|---|
| **Position / order bias** *(verified 3-0)* | Judge favors a candidate by its **slot**, not merit. Worst **when candidates are close in quality**; shrinks when one clearly dominates. | Randomize candidate order per call; **swap and re-judge** (AutoSxS response-flipping); prefer **pointwise absolute** scoring over "pick the best," which is the most position-sensitive. |
| **Verbosity / length bias** | Longer answers scored higher regardless of quality. | Rubric explicitly decoupling length from quality; normalize; penalize padding. |
| **Self-preference / self-enhancement** *(verified 3-0)* | Judge inflates scores of its **own** outputs. GPT-4 shows "a significant degree of self-preference." A leading mechanism is **familiarity / low perplexity** — judges over-rate text that *looks like their own*, even when it isn't — though **self-recognition** is a contested rival explanation. | **Blind labeling** (Joust already does this — candidates are A/B/C with no model identity); **disjoint-family jury** (PoLL); fixed neutral judge. *This is the bias that most threatens a tournament where the judge's own family is a contestant.* |
| **Sycophancy / agreeableness** | Judge agrees with assertive/confident framing. | Strip self-summaries; have the judge inspect the *real output*, not the candidate's claims about it (Joust rubric already says this). |
| **Leniency / clustering** | Scores bunch near the top of the scale. | Forced rubric anchors; pairwise tie-breaks; calibration. |
| **Formatting / familiarity bias** | Familiar-looking idioms rewarded over unfamiliar-but-correct ones. | Joust's rubric already warns against this (judge against the task's stated runtime, not what "looks idiomatic"). |

**The canonical mitigation menu** (from the survey, *verified 3-0*): ensemble/jury
aggregation across diverse judges, position manipulation (split-and-merge / flipping),
reference-guided verdicts, **criterion decomposition** (one judge per dimension), batch
calibration, probability-discrepancy analysis, and human oversight.

**Validating the judge.** The field validates judges by **agreement with human labels**:
Cohen's κ (categorical/preference), accuracy/precision/recall/F1, or Spearman/Pearson
correlation (scores). Anthropic, Google AutoSxS, Prometheus, and PoLL all report one of
these. *A judge you haven't validated against humans is an unmeasured instrument.*

---

## 7. Evaluating agent trajectories (not just final answers)

For multi-step, tool-using agents the field splits along **outcome-level vs step-level**
reward:

- **Outcome-level** — grade the final artifact/state. Anthropic's recommended default
  ("grade what the agent produced, not the path"). Robust, creativity-friendly, the Joust
  model.
- **Step-level / Process Reward Models (PRMs)** **[supplementary]** — reward each step (used
  heavily in math/reasoning RL). More signal, but brittle and expensive to label, and it can
  punish valid alternative paths. Best reserved for *diagnostics* or RL training, not for
  picking a tournament winner.
- **Execution / deterministic-criteria benchmarks** — the production standard for tool-use:
  - **τ²-bench** (Sierra Research, [arXiv:2506.07982](https://arxiv.org/abs/2506.07982),
    [GitHub](https://github.com/sierra-research/tau2-bench)) *(verified 3-0)*: reward =
    **multiplicative product** of components — a **DB-state hash comparison** (final state vs
    a target built by replaying gold `evaluation_criteria.actions`) **× deterministic tool-call
    matching × communication checks**. LLM judging is reserved *only* for an experimental
    natural-language-assertion path. A clean **RLVR template**: gate on verifiable criteria,
    judge only the subjective remainder.
  - **SWE-bench** — resolve a real GitHub issue in a full repo; graded by **running the
    repository's tests**. Pure execution-based verification.
  - **Qwen AgentWorld / AgentWorldBench** (§5) — learned environment simulation to check
    predicted vs real state across trajectories.

**Takeaway for Joust:** its tasks are mostly single-pass artifacts, so outcome grading is
correct. Where a task *has* an executable check (code/tests/state), lean on it as the gate
and let the 5-score judge handle craft and the non-executable remainder.

---

## 8. Concrete recommendations for the Joust Engine

A proposed scoring pipeline that fuses the issue's two lists (5 scores + rule checks) with
the verified state of the art:

### 8.1 Two-tier scoring: gate → judge

**Tier 1 — deterministic verifier gate (cheap, no Opus tokens).** Per task type, run what
applies and record pass/fail + detail:

| Check | Applies to | Signal |
|---|---|---|
| JSON valid / parses | structured output | hard gate |
| Schema / `response_format` match | structured output | hard gate |
| Compiles / imports / runs | code | hard gate |
| Unit/integration tests pass | code with tests | scored % |
| Exact / fuzzy match | tasks with a reference | scored |
| Regex / constraint checks | format constraints | gate |
| Tool-call & final-state checks | agentic tasks | scored (τ²-style) |

A hard-gate failure → candidate is heavily penalized or eliminated *before* judging. This is
Anthropic's code-vs-model grader split and the RLVR pattern, applied verbatim.

### 8.2 Tier 2 — the 5-score LLM judge (blind Opus), one isolated pass per dimension

For each surviving candidate, score **Format, Factuality, Consistency, Realism, Quality**.
Per Anthropic, give **each dimension its own rubric and isolated judge call**, emitting a
**number + one-line cited justification** (cite the line/behavior, per the existing rubric).
Aggregate to a per-candidate vector; combine with Tier-1 results into the ranking.

- *Format* — only the parts a validator can't express (is the structure *appropriate*?).
- *Factuality* — claim-decomposition + groundedness; for code, summary-vs-behavior match.
- *Consistency* — internal contradiction check; optionally self-consistency over 2–3 judge
  samples.
- *Realism* — plausibility; ground in observable outcomes where an environment exists.
- *Quality* — overall craft (the existing correctness/readability/robustness/efficiency set).

### 8.3 Keeping the judge blind & bias-resistant

- **Keep blind labeling** (A/B/C, no model identity) — the primary defense against
  self-preference, which is the bias that most threatens a tournament whose judge family is
  also a contestant.
- **Randomize candidate order** in every judge call; where a pass is pairwise, **swap and
  re-judge** (AutoSxS flipping).
- **Prefer pointwise/absolute rubric scoring** for the 5 dimensions (comparable across runs,
  least position-sensitive); use **pairwise only as a tie-breaker** between near-equal
  finalists (pairwise's higher resolution is worth its position-bias cost only when the
  margin is small).
- **Decouple length from quality** explicitly in each rubric.
- **(Optional) jury upgrade** — for high-stakes or grand-loop decisions, a small
  **disjoint-family panel** (PoLL) reduces intra-model bias and can be cheaper than a single
  large judge; weigh against the 2026 correlated-errors critique before assuming big gains.

### 8.4 Ranking N candidates

- **Default: pointwise.** Score all N independently on the rubric → rank by aggregate. O(N),
  no position bias across the list, comparable run-to-run.
- **Tie-break: pairwise** between the top 2–3 with order-swapping, because pairwise resolution
  is highest exactly when candidates are close — *which is also when position bias bites
  hardest*, so swapping is mandatory there.
- **Avoid pure listwise** "rank all N in one prompt" for the final decision — most exposed to
  primacy/position effects.
- *Open question:* the empirically optimal N-candidate method (pointwise vs all-pairs
  Bradley-Terry/Elo vs listwise) is **not settled** in the literature surveyed; the above is a
  reasoned synthesis, not a sourced verdict.

### 8.5 Validating the judge itself

- Build a small **human-labeled gold set** of past tournaments (your own winner picks).
- Measure judge ↔ human agreement with **Cohen's κ** (winner pick) and **Spearman** (per-
  dimension scores). Anthropic/Google/Prometheus all gate on human agreement.
- Set a **κ threshold** the judge must clear before it's trusted to crown winners
  unattended (e.g. in grand loops). *The threshold is a policy choice — pick it deliberately;
  PoLL hit κ≈0.76 on QA as a rough "good judge" reference point.*
- Apply **clustered + paired** standard errors (Anthropic) when declaring a winner, so a
  statistical tie isn't reported as a decisive win.

---

## Caveats, open questions & what's *not* yet substantiated

**Time-sensitivity (mid-2026).** G-Eval (2023) is foundational but superseded in absolute
quality; Vertex AI AutoSxS branding has been absorbed into the Gen AI Evaluation Service
(mechanism stable, product surface not); Qwen-AgentWorld is days old — exact
model/benchmark counts and judging-quality claims are not yet independently replicated.

**Contested points (flagged, not settled).**
- *Self-preference root cause* — **familiarity/low-perplexity** vs **self-recognition** is
  genuinely disputed. Treat familiarity as *one* mechanism, not consensus.
- *Jury advantage* — PoLL beats the **average** individual judge; **correlated errors** among
  panelists cap real-world gains (2026 critique). Don't assume a panel strictly dominates a
  good single judge.

**Under-substantiated in the verified pass (researched via lighter search; confirm before
relying):** Constitutional AI/RLAIF specifics, OpenAI Evals/simple-evals/RFT-grader details,
Prometheus 1/2, JudgeBench, RewardBench, FLAMe, RAGAS/DeepEval/Braintrust/Langfuse/Arize,
debate-based judging, and process reward models / step-level reward.

**Genuinely open for Joust:**
1. Best paradigm for ranking **N>2** candidates given pairwise position bias is worst on
   close calls.
2. What OpenAI's and the Prometheus/RewardBench/FLAMe lines concretely prescribe for a
   tournament judge.
3. How (if at all) step-level PRMs should complement outcome grading for single-pass attempts.
4. Whether the fixed blind Opus judge should be supplemented by a disjoint-family panel — and
   the concrete human-label κ target that should gate autonomous winner selection.

---

## Sources

**Verified against primary sources (3-vote adversarial pass):**
- LLMs-as-Judges survey — [arXiv:2412.05579](https://arxiv.org/abs/2412.05579)
- G-Eval — [arXiv:2303.16634](https://arxiv.org/abs/2303.16634)
- Cohere "Replacing Judges with Juries" (PoLL) — [arXiv:2404.18796](https://arxiv.org/abs/2404.18796)
- "Judging the Judges" (position bias) — [arXiv:2406.07791](https://arxiv.org/abs/2406.07791)
- "Self-Preference Bias in LLM-as-a-Judge" — [arXiv:2410.21819](https://arxiv.org/html/2410.21819v2)
- Anthropic — [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Anthropic — [A statistical approach to model evaluations](https://www.anthropic.com/research/statistical-approach-to-model-evals) / [arXiv:2411.00640](https://arxiv.org/abs/2411.00640)
- Google — [Vertex AI AutoSxS](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/side-by-side-eval)
- Sierra Research τ²-bench — [arXiv:2506.07982](https://arxiv.org/abs/2506.07982) / [GitHub](https://github.com/sierra-research/tau2-bench)
- Qwen-AgentWorld — [arXiv:2606.24597](https://arxiv.org/abs/2606.24597) / [blog](https://qwen.ai/blog?id=qwen-agentworld) / [GitHub](https://github.com/QwenLM/Qwen-AgentWorld) / [dataset](https://huggingface.co/datasets/Qwen/AgentWorldBench)

**Supplementary (lighter verification):**
- Anthropic — [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [Building effective AI agents](https://www.anthropic.com/research/building-effective-agents)
- OpenAI — [Graders guide](https://developers.openai.com/api/docs/guides/graders) · [Reinforcement fine-tuning](https://developers.openai.com/api/docs/guides/reinforcement-fine-tuning) · [Model graders cookbook](https://cookbook.openai.com/examples/reinforcement_fine_tuning)
- Google FLAMe — [arXiv:2407.10817](https://arxiv.org/abs/2407.10817)
- Prometheus — [arXiv:2310.08491](https://arxiv.org/abs/2310.08491) · [GitHub](https://github.com/prometheus-eval/prometheus)
- MT-Bench / Chatbot Arena (Zheng et al. 2023) — [arXiv:2306.05685](https://arxiv.org/abs/2306.05685)
- Eugene Yan — [Evaluating LLM-Evaluators](https://eugeneyan.com/writing/llm-evaluators/)
- RLVR overview — [Emergent Mind: RLVR](https://www.emergentmind.com/topics/rl-with-verifiable-rewards-rlvr)
- Qwen-AgentWorld talk — [YouTube](https://youtu.be/VzmMQWRhlBw)
