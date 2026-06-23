# Security Policy

## Why this matters here

Joust Engine is not an ordinary plugin: by design it **executes model-generated code** (candidate workspaces) and can run against arbitrary target repositories, and it **handles provider API credentials** (Anthropic, GLM/z.ai, OpenAI Codex, MiniMax, xAI Grok, on-device MLX). That makes its executable surface security-sensitive, so we take reports seriously.

Existing mitigations you should be aware of when assessing a report:

- **Verify isolation.** Untrusted build/test/lint code runs through a single `je_verify_exec` chokepoint with a sandbox policy (`JE_VERIFY_SANDBOX`, default `auto`) and a wall-clock watchdog; commands run as argv (no `eval`).
- **Credential scrubbing.** Provider env credentials are unset before verify; on-disk credentials are denied by the sandbox (macOS). Dogfood evidence is scrubbed before filing to the public repo.
- Known gaps are tracked openly (e.g. the macOS default-deny sandbox profile in #18, and Linux sandbox coverage in #12).

## Reporting a vulnerability

**Please do not open a public issue, PR, or discussion for a vulnerability.**

Use **GitHub's private vulnerability reporting**:

1. Go to the repository's **Security** tab → **Report a vulnerability** (Privately report a vulnerability), or
2. Open `https://github.com/robanderson/joust-engine/security/advisories/new`.

This opens a private advisory visible only to the maintainers and you.

### What to include

- A clear description of the issue and its impact.
- The affected component (e.g. `bin/je-git.sh`, `workflows/tournament.mjs`) and version/commit.
- Reproduction steps or a proof of concept, and your assessed severity.

### What to expect

- We aim to acknowledge a report within a few days, confirm the issue, and discuss a fix and disclosure timeline with you.
- Please give us a reasonable window to release a fix before any public disclosure. Credit is offered to reporters who follow this process (opt-out available).

## Scope

In scope: the engine's executable surface — the `bin/` runners/helpers, `workflows/tournament.mjs`, the verify/sandbox path, credential handling, and the dogfood evidence/unblinding filters.

Out of scope: vulnerabilities in third-party CLIs/models the engine dispatches to (`claude`, `codex`, `grok`, the `omlx` server, etc.) — report those upstream.
