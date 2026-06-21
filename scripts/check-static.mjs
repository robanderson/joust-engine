#!/usr/bin/env node
// scripts/check-static.mjs — "CI lane 1b": deterministic, model-free static checks.
//
// These guard the plugin's packaging without running the skill: a renamed agent
// file or a malformed manifest would otherwise only surface when a user installs
// the plugin. None of this touches a model or the network.
//
// Checks:
//   1. plugin.json / marketplace.json / trigger-evals.json are valid JSON.
//   2. Every agent listed in plugin.json `components.agents` has agents/<name>.md.
//   3. Every skill listed in plugin.json `components.skills` has skills/<name>/SKILL.md.
//
// Deliberately NOT checked here: version equality across manifests — whether
// marketplace.json's `version` should match plugin.json's is unresolved (see
// issue #3), so asserting it now would prejudge that decision.
//
// Exits 0 iff every check passes.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const note = (msg) => problems.push(msg)

// 1. JSON manifests must parse.
const JSON_FILES = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'trigger-evals.json',
]
const parsed = {}
for (const rel of JSON_FILES) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) {
    note(`missing JSON file: ${rel}`)
    continue
  }
  try {
    parsed[rel] = JSON.parse(readFileSync(abs, 'utf8'))
    console.log(`✓ valid JSON  ${rel}`)
  } catch (e) {
    note(`invalid JSON in ${rel}: ${e.message}`)
  }
}

// 2 & 3. plugin.json component files must exist on disk.
const plugin = parsed['.claude-plugin/plugin.json']
if (plugin) {
  const components = plugin.components || {}
  for (const agent of components.agents || []) {
    const rel = join('agents', `${agent}.md`)
    if (existsSync(join(ROOT, rel))) console.log(`✓ agent file  ${rel}`)
    else note(`plugin.json lists agent "${agent}" but ${rel} is missing`)
  }
  for (const skill of components.skills || []) {
    const rel = join('skills', skill, 'SKILL.md')
    if (existsSync(join(ROOT, rel))) console.log(`✓ skill file  ${rel}`)
    else note(`plugin.json lists skill "${skill}" but ${rel} is missing`)
  }
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} static check(s) failed:`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\nAll static checks passed.')
