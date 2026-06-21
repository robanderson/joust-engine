// Regression tests for the #45 dispatch-failure classification.
//
//   node tournament-dispatch-preflight.test.mjs   (no deps; exits 0 on pass, 1 on fail)
//
// An attempt can fail two ways: (a) the model RAN but lost (normal), or (b) it NEVER ran
// because its required agent type is not registered this session — an infrastructure drop
// that silently shrinks N. We surface (b) loudly and distinctly. The workflow runtime has
// no agent-registry query primitive, so we classify the dispatch error and report an
// effective-vs-requested field per round. Tests are pure source/snippet assertions plus a
// behavioral extraction of the two pure helpers, matching the existing tournament tests.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'tournament.mjs'), 'utf8')

let failed = 0
const check = (name, cond) => { if (cond) console.log(`ok   - ${name}`); else { console.error(`FAIL - ${name}`); failed++ } }

function extractFn(src, name) {
  const sig = `function ${name}(`
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`could not find ${sig}`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

console.log('== tournament.mjs dispatch-failure classification (#45) ==')

// (1) STRUCTURAL — the machinery exists and is wired in.
check('(struct) drop accumulator declared', SRC.includes('const dispatchDrops = []'))
check('(struct) classifier helper declared', SRC.includes('function isUnregisteredAgentError('))
check('(struct) per-round summary helper declared', SRC.includes('function dispatchDropSummary('))
check('(struct) catch classifies unregistered-agent distinctly',
  SRC.includes('if (opts.agentType && isUnregisteredAgentError(msg))'))
check('(struct) loud per-attempt drop marker', SRC.includes('JE-DISPATCH-DROP'))
check('(struct) loud per-round warning marker', SRC.includes('JE-DISPATCH-WARNING'))
check('(struct) round-1 summary call wired', SRC.includes("dispatchDropSummary('Round 1', dispatchDrops"))
check('(struct) round-2 summary call wired', SRC.includes("dispatchDropSummary('Round 2', dispatchDrops"))
check('(struct) empty round-1 names the unregistered type(s)',
  SRC.includes('required agent type(s) NOT REGISTERED'))
// Regression guard: the generic errored line must remain for the (a) ran-but-lost path.
check('(struct) generic errored line still present for ran-but-lost',
  SRC.includes('errored: ${msg.slice(0, 100)}'))

// (2) BEHAVIORAL — eval the two pure helpers and exercise them.
const classifierSrc = extractFn(SRC, 'isUnregisteredAgentError')
const summarySrc = extractFn(SRC, 'dispatchDropSummary')
// eslint-disable-next-line no-new-func
const helpers = new Function(`${classifierSrc}\n${summarySrc}\nreturn { isUnregisteredAgentError, dispatchDropSummary }`)()
const { isUnregisteredAgentError, dispatchDropSummary } = helpers

// classifier: the canonical harness error is unregistered-agent...
check('(class) matches canonical "agent type \'x\' not found"',
  isUnregisteredAgentError("Error: agent type 'joust-engine:joust-grok' not found") === true)
check('(class) matches namespaced-or-bare agent type not found',
  isUnregisteredAgentError('agent type joust-grok not found') === true)
// ...but a normal task failure that merely contains "not found" is NOT misclassified.
check('(class) does NOT match a generic "file not found"',
  isUnregisteredAgentError('Error: file not found: deliverable.md') === false)
check('(class) does NOT match an empty/odd error',
  isUnregisteredAgentError('') === false && isUnregisteredAgentError('boom') === false)
// A runner attempt that RAN but lost may emit a multi-line transcript that mentions
// "agent type" AND, elsewhere, an unrelated "... not found" — must NOT be misclassified.
check('(class) does NOT match phrases split across newlines (ran-but-lost transcript)',
  isUnregisteredAgentError('I considered which agent type to use.\nThen: module not found error') === false)
check('(class) does NOT match phrases far apart on different lines',
  isUnregisteredAgentError('The agent type discussion...\n...\nbash: foo: command not found') === false)

// summary: returns null when no infra drops for that phase...
check('(sum) null when no drops this phase',
  dispatchDropSummary('Round 1', [], 5, 5) === null)
check('(sum) null when drops belong to a different phase',
  dispatchDropSummary('Round 1', [{ phase: 'Round 2', agentType: 'joust-engine:joust-grok' }], 5, 4) === null)
// ...and a loud, deduped, effective-vs-requested warning when there are.
const drops = [
  { label: 'candidate-4', displayModel: 'grok-build', agentType: 'joust-engine:joust-grok', phase: 'Round 1' },
  { label: 'candidate-5', displayModel: 'grok-composer-2.5-fast', agentType: 'joust-engine:joust-grok', phase: 'Round 1' },
]
const w = dispatchDropSummary('Round 1', drops, 5, 3)
check('(sum) warns with JE-DISPATCH-WARNING marker', typeof w === 'string' && w.includes('JE-DISPATCH-WARNING [Round 1]'))
check('(sum) reports the dropped count', w.includes('2/5 attempt(s) dropped'))
check('(sum) reports effective vs requested field', w.includes('Effective field 3/5'))
check('(sum) dedupes the agent type (named once)',
  (w.match(/joust-engine:joust-grok/g) || []).length === 1)
check('(sum) points at the session-restart fix', /restart the session/i.test(w))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
