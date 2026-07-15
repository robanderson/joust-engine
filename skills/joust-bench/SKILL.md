---
name: joust-bench
description: Benchmark generation throughput (cold vs hot tok/s) for every model the joust-engine system can call (Anthropic / GLM / local MLX / codex / MiniMax / claudex via a local CLIProxyAPI proxy). Two workload profiles — light (tiny paragraph) and heavy (>5k-token input context + long >5k-token output, representative of coding/agentic work). Thin wrapper over bin/je-bench.mjs. Use when the user asks to benchmark model speed, measure tokens/second, compare cold vs hot throughput across providers, or run /je-bench.
---

# je-bench — model throughput benchmark

Thin wrapper over `bin/je-bench.mjs`. It measures **tokens/second** for each
selected model on a **cold** call and an immediate **hot** call, prints a table,
and appends every result to `<plugin>/.bench/results.jsonl`.

## What to run

Resolve the plugin root (the dir containing `plugin.json` for `joust-engine`),
then run the benchmark script with `node`. Pass the user's selection through
verbatim; default to `--models all`.

```sh
node "<plugin-root>/bin/je-bench.mjs" --models <selection> [--profile light|heavy]
```

`<selection>` (comma-separated, de-duped):
- `all` — every callable model (local MLX list discovered live). **Default.**
- a provider: `anthropic` | `glm` | `local` | `codex` | `minimax` | `claudex`
- `<provider>:<id>` — e.g. `glm:glm-5.1`, `codex:codex-high`, `anthropic:opus`, `local:<omlx-id>`, `claudex:gpt-5.6-sol`
- a bare id — `opus`, `glm-5.2`, `minimax-m3`, `codex-high`, `gpt-5.6-sol`, a local id

**Profiles** (`--profile`, default `light`; shorthand `--heavy` / `--light`):
- `light` — a ~200-word paragraph; fast/cheap throughput smoke (output cap 2048).
- `heavy` — a representative coding/agentic workload: a fixed **>5k-token input
  context** plus an instruction that elicits a long structured deliverable
  (**>5k-token decode**), output cap 8192, longer timeouts. Use this when the
  light profile's few-hundred-token decode is too small to characterise real
  coding throughput. The profile name is stored on every result row.

Useful flags: `--list` (dry-run; prints the resolved plan + profile, makes NO
model calls — cheap way to confirm the selection before spending),
`--timeout <secs>`, `--help`.

## Guidance

- For a quick, cheap check first, run `--list` with the same `--models` selection
  and show the user the plan before the real (paid) sweep.
- The script handles auth from the environment exactly as the runners do
  (`ZAI_API_KEY`, `MINIMAX_API_KEY`, `OMLX_AUTH_TOKEN`; Anthropic uses the
  session's own auth; codex uses `~/.codex/auth.json`; claudex reads a
  client-token file — `JE_CLAUDEX_TOKEN_FILE`, default
  `~/.config/cliproxyapi/client-token` — against a local CLIProxyAPI proxy at
  `JE_CLAUDEX_BASE_URL`, default `http://127.0.0.1:8317`). A provider whose key is
  unset is recorded as a failed row and the sweep continues — surface those rows.
- Results accumulate across runs in the append-only JSONL; point the user at
  `<plugin>/.bench/results.jsonl` for history.
- Report the printed table back to the user, including any failures and the `*`
  estimated-token note (codex fallback). The table shows `cIn` (cold input
  tokens), `cOut`/`hOut` (cold/hot output tokens) — under `--profile heavy`
  confirm `cIn` and the output columns are both comfortably over 5k.
- **Heavy profile is much slower and pricier** (each call generates thousands of
  tokens, and slow local models can approach the 1200s local timeout). For an
  all-models heavy sweep, warn the user and consider a representative subset.

See `bin/README.je-bench.md` for the full usage and results-format reference.
