# Contributing to Joust Engine

Thanks for your interest in improving **Joust Engine** — a self-contained Claude Code plugin that runs model-diverse, best-of-N coding tournaments. This guide covers local setup, how to run the tests, the conventions we follow, and the release process.

## Prerequisites

- **Node.js 22** (see [`.nvmrc`](.nvmrc); the engine requires `>=20`). With `nvm`: `nvm use`.
- **Platform:** the engine and its `bin/*.sh` helpers are **macOS-first**. **Linux is currently an unsupported platform** — CI exercises the deterministic test suite on Linux, but the OS-level verify sandbox is macOS-only. Linux support is tracked in [#12](https://github.com/robanderson/joust-engine/issues/12).
- No build step — the plugin is shipped as-is (skills + agents + `bin/` runners + the workflow engine).

## Running the tests

A single entry point runs everything:

```sh
npm test        # discover + run every *.test.mjs / *.test.sh under workflows/ and bin/
npm run check   # model-free static checks (manifests are valid JSON; every agent/skill in plugin.json exists on disk)
npm run ci      # what CI runs: npm run check && npm test
```

CI (`.github/workflows/ci.yml`) runs `npm run ci` on **Linux and macOS** for every push and PR.

### Two test layers

The product is partly model-driven, so be precise about what is testable:

- **Layer A — deterministic tooling** (`bin/*.mjs`, `bin/*.sh`, the pure helpers in `workflows/`): the parser, git/gh helpers, contribution math, output parsing, key-hygiene guards. These call **no model and no network** — the "API key" tests inject *fake* secrets and assert they're dropped; the bench test parses *recorded* fixtures. **All current tests live here**, and CI runs them fully.
- **Layer B — skill behaviour** (does Claude trigger on `@@JE`, run N blind attempts, distil guidance, open the PR): needs a real model in the loop, so it is **not** covered by ordinary CI. This is an evals concern (seeded by `trigger-evals.json`), intentionally left to a separate, opt-in lane.

> ⚠️ Naming note: the top-level `workflows/` directory is the **tournament engine source**, *not* GitHub Actions. CI lives in `.github/workflows/`.

## Branch & PR conventions

- Work on a feature branch; open a **draft PR** early.
- **Reference the issue** you're addressing (e.g. `Addresses #5 finding #3`); use `Closes #N` when a PR fully resolves an issue.
- Keep PRs focused and confirm `npm run ci` is green locally before marking ready.
- **Never** commit secrets, and never paste a candidate→model unblinding mapping into a public artifact (issue bodies, PRs). The dogfood helper enforces this; you should too.

## The dogfood backlog

Problems found while running tournaments are filed as GitHub Issues labelled `dogfood` via the bundled helper `bin/je-issue.sh` (the only forge-touching part of the engine):

```sh
bin/je-issue.sh new --sev sev2 --area parse --title "…" --evidence-file EV.md
bin/je-issue.sh next        # top open item (sev1 → sev3)
```

Full convention: [`DOGFOOD.md`](DOGFOOD.md) and [`skills/joust-engine/references/dogfood.md`](skills/joust-engine/references/dogfood.md).

## Release checklist

`.claude-plugin/plugin.json`'s `version` is the source of truth; the same value must appear in the two other manifests, a dated CHANGELOG entry, and a matching git tag:

1. [ ] Bump `version` in `.claude-plugin/plugin.json`.
2. [ ] Set the **same** value in `.claude-plugin/marketplace.json` and `package.json`.
3. [ ] Add a dated entry to [`CHANGELOG.md`](CHANGELOG.md).
4. [ ] Tag the release commit (`git tag vX.Y.Z`) and push the tag.
5. [ ] Confirm `npm run ci` is green on the release commit.

The `@@DE` dev-marketplace version is **derived automatically** — no manual bump. `bin/rebrand.mjs`
publishes `X.Y.(Z+1)-dev.<N>` (a prerelease of the next patch of the release above; `N` = commits
since the latest tag, so it resets each release), keeping the dev and prod channels in lockstep.

## Reporting security issues

Please do **not** open a public issue for vulnerabilities — see [`SECURITY.md`](SECURITY.md) for the private disclosure path.
