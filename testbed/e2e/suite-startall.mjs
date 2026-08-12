// E2E for the start-all workflow: executes the ACTUAL start-all.js with a stubbed
// async agent() and asserts the global scheduler from catalog issue #71 —
//   - it schedules from ONE flat blocked_by DAG (no module barrier, no run-milestone),
//   - it reloads that DAG mid-run so tickets added while it runs still execute,
//   - and every merge rule for a reload is enforced, including the escalation paths.
//
// The last scenario is a PARITY test against run-milestone. The maintainer accepted
// duplicating the dispatch loop across two workflow files (they cannot import each
// other); this is the guard that turns silent behavioral drift into a failed gate.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'startall'
const load = (name) =>
  readFileSync(fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/workflows/' + name, import.meta.url)), 'utf8')
    .replace('export const meta', 'const meta')

const SRC = load('start-all.js')
const RUNMILESTONE = load('run-milestone.js')

// Drive a workflow body with a stubbed agent(). `respond` returns the agent's payload;
// `onSettle` (optional) fires after each ticket's deliver, which is where a test
// simulates the outside world adding or editing a ticket mid-run.
async function drive(body, args, respond) {
  const events = []
  const logs = []
  const workflowCalls = []
  let active = 0
  let maxActive = 0
  let seq = 0
  const activeIds = new Set()
  const overlaps = new Set()
  let maxLanes = 0
  const firstStart = {} // ticket id -> seq of its first agent call
  const deliverEnd = {} // ticket id -> seq when its deliver returned

  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    const id = (label.split(':')[1] || '').split('#')[0]
    active += 1
    maxActive = Math.max(maxActive, active)
    if (!label.startsWith('rescan')) {
      for (const other of activeIds) if (other !== id) overlaps.add([id, other].sort().join('|'))
      activeIds.add(id)
      maxLanes = Math.max(maxLanes, activeIds.size)
      if (firstStart[id] === undefined) firstStart[id] = seq
    }
    seq += 1
    events.push({ ev: 'start', label, isolation: opts.isolation || null, effort: opts.effort || null, prompt })
    await new Promise((r) => setTimeout(r, 2)) // let sibling lanes interleave
    const res = await respond({ prompt, opts, label, id })
    if (kind(label) === 'deliver') deliverEnd[id] = seq
    seq += 1
    events.push({ ev: 'end', label })
    active -= 1
    activeIds.delete(id)
    return res
  }
  const workflow = async (name, a) => { workflowCalls.push({ name, args: a }); return { results: [] } }
  const fn = new Function(
    'agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', 'workflow',
    `"use strict"; return (async () => { ${body}\n })()`
  )
  let result = null
  let error = null
  try {
    result = await fn(agent, null, null, (m) => logs.push(m), () => {}, args, { total: null, spent: () => 0, remaining: () => Infinity }, workflow)
  } catch (e) { error = e }
  return { result, error, events, logs, maxActive, overlaps, workflowCalls, maxLanes, firstStart, deliverEnd }
}

const kind = (l) => l.split(':')[0]
const tk = (id, blockedBy, module) => ({ id, path: `docs/prd/${module || 'x'}/tickets/${id}.md`, issue: 1, module: module || 'x', ...(blockedBy ? { blockedBy } : {}) })

const plan = (id) => ({ planPath: `docs/plans/${id}.md`, summary: 'ok', content: 'PLAN_' + id })
const goodBuild = (id) => ({ branch: `ticket/${id}`, testsPassed: true, testOutput: 'green', deviations: '' })
const CLEAR = { verdict: 'CLEAR', checkedNote: 'ok' }
const OK_DELIVERY = { merged: true, issueClosed: true, dodPassed: true }

// A responder that delivers everything, and answers rescans from a mutable ticket list
// the test controls — that list stands in for docs/prd on disk.
const makeRespond = (scanState) => async ({ label, id }) => {
  if (label.startsWith('rescan')) {
    if (scanState.fail) return { ok: false, detail: 'dag-scan exited 1: half-written ticket' }
    scanState.calls += 1
    if (scanState.onScan) scanState.onScan(scanState.calls)
    // `state` mirrors what PUBLISH-SUMMARY-JSON reports for each ticket. It is what the
    // rescan needs in order to apply the same closed-issue filter step 4 applies at
    // launch (catalog issue #136).
    return { ok: true, tickets: scanState.tickets.map((t) => ({ id: t.id, module: t.module || 'x', path: t.path, blockedBy: t.blockedBy || [], issue: t.issue, state: t.state })) }
  }
  if (kind(label) === 'plan') return plan(id)
  if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(id)
  if (kind(label) === 'review') return CLEAR
  if (kind(label) === 'deliver') {
    if (scanState.onDeliver) scanState.onDeliver(id)
    return OK_DELIVERY
  }
  return null
}
const statusOf = (result, id) => (result.results.find((r) => r.id === id) || {}).status

export async function run() {
  // ---- SA1: the module barrier is gone -----------------------------------------------
  // Two modules with NO dependency between them. Under the old driver these could never
  // overlap; under the flat DAG they must.
  {
    const tickets = [tk('A-1', [], '01-a'), tk('A-2', ['A-1'], '01-a'), tk('B-1', [], '02-b'), tk('B-2', [], '02-b')]
    const st = { tickets, calls: 0 }
    const { result, error, overlaps, workflowCalls } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 3, rescanEvery: 0 }, makeRespond(st))
    check(S, 'SA1 no error', !error, error && error.message)
    eq(S, 'SA1 every ticket delivered', result && result.results.every((r) => r.status === 'delivered'), true)
    eq(S, 'SA1 reports the global scheduler', result && result.scheduler, 'global-dag')
    check(S, 'SA1 tickets from DIFFERENT modules ran concurrently (no module barrier)',
      [...overlaps].some((p) => p.includes('A-') && p.includes('B-')))
    eq(S, 'SA1 start-all no longer composes run-milestone', workflowCalls.length, 0)
    check(S, 'SA1 source contains no workflow() call', !/\bworkflow\s*\(/.test(SRC))
  }

  // ---- SA2: cross-module blocked_by gates directly ------------------------------------
  {
    const tickets = [tk('A-1', [], '01-a'), tk('B-1', ['A-1'], '02-b')]
    const st = { tickets, calls: 0 }
    const order = []
    const respond = makeRespond(st)
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 4, rescanEvery: 0 },
      async (c) => { if (kind(c.label) === 'plan') order.push(c.id); return respond(c) })
    check(S, 'SA2 no error', !error, error && error.message)
    eq(S, 'SA2 cross-module blocker ran first', order, ['A-1', 'B-1'])
    eq(S, 'SA2 both delivered', result && result.delivered, 2)
  }

  // ---- SA3: failure cascades along ticket edges, independents continue ----------------
  {
    const tickets = [tk('A-1', [], '01-a'), tk('A-2', ['A-1'], '01-a'), tk('B-1', [], '02-b')]
    const st = { tickets, calls: 0 }
    const respond = makeRespond(st)
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 3, rescanEvery: 0 },
      async (c) => (c.id === 'A-1' && kind(c.label) === 'build'
        ? { branch: 'ticket/A-1', testsPassed: false, testOutput: 'RED' }
        : respond(c)))
    check(S, 'SA3 no error', !error, error && error.message)
    eq(S, 'SA3 the failing ticket is failed', statusOf(result, 'A-1'), 'failed')
    eq(S, 'SA3 its dependent is skipped', statusOf(result, 'A-2'), 'skipped-dependency')
    eq(S, 'SA3 an INDEPENDENT ticket still delivers', statusOf(result, 'B-1'), 'delivered')
  }

  // ---- SA4: supervised forces sequential and stops on the first pause -----------------
  {
    const tickets = [tk('A-1', [], '01-a'), tk('B-1', [], '02-b')]
    const st = { tickets, calls: 0 }
    const respond = makeRespond(st)
    const { result, error, maxActive } = await drive(SRC, { tickets, mode: 'supervised', concurrency: 4, rescanEvery: 0 },
      async (c) => (kind(c.label) === 'deliver' ? { merged: false, issueClosed: false, dodPassed: false, awaitingMerge: true, prUrl: 'http://x/1' } : respond(c)))
    check(S, 'SA4 no error', !error, error && error.message)
    eq(S, 'SA4 supervised forced concurrency to 1', result && result.concurrency, 1)
    eq(S, 'SA4 never more than one agent in flight', maxActive, 1)
    eq(S, 'SA4 first ticket awaits a human merge', statusOf(result, 'A-1'), 'awaiting-human-merge')
    eq(S, 'SA4 the run stops rather than continuing', statusOf(result, 'B-1'), 'not-started')
  }

  // ---- SA5: a ticket added mid-run is picked up AND executed --------------------------
  {
    const tickets = [tk('A-1', [], '01-a'), tk('A-2', [], '01-a'), tk('A-3', [], '01-a')]
    const st = { tickets: tickets.slice(), calls: 0 }
    // after the first delivery, the outside world adds a ticket
    st.onDeliver = (id) => { if (id === 'A-1') st.tickets.push(tk('NEW-1', [], '03-new')) }
    const { result, error, events } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 1 }, makeRespond(st))
    check(S, 'SA5 no error', !error, error && error.message)
    eq(S, 'SA5 the mid-run ticket was executed', statusOf(result, 'NEW-1'), 'delivered')
    eq(S, 'SA5 ticket count grew', result && result.ticketCount, 4)
    check(S, 'SA5 the reload agent runs the deterministic scan script',
      events.some((e) => e.ev === 'start' && e.label.startsWith('rescan') && /dag-scan\.mjs/.test(e.prompt)))
    check(S, 'SA5 the reload agent publishes new tickets so delivery can close them',
      events.some((e) => e.ev === 'start' && e.label.startsWith('rescan') && /publish-tickets\.mjs/.test(e.prompt)))
    check(S, 'SA5 the reload agent refreshes the visualization',
      events.some((e) => e.ev === 'start' && e.label.startsWith('rescan') && /dag-report\.mjs/.test(e.prompt)))
    check(S, 'SA5 reload runs at low effort (it only relays script output)',
      events.some((e) => e.ev === 'start' && e.label.startsWith('rescan') && e.effort === 'low'))
  }

  // ---- SA5b (issue #136): the mid-run rescan applies the SAME closed-issue filter as
  // step 4. Without it, an already-delivered ticket is pulled back into the running
  // schedule, re-planned and re-built against a codebase that already contains its work.
  //
  // Both directions are asserted IN THE SAME TEST on purpose: a closed ticket must be
  // dropped AND an open one must still be picked up. Neither assertion can be satisfied by
  // breaking the other — neutering the rescan fails the second, and dropping the filter
  // fails the first.
  {
    const tickets = [tk('A-1', [], 'x'), tk('A-2', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    const dispatched = []
    st.onDeliver = (id) => {
      dispatched.push(id)
      if (id === 'A-1') {
        // the outside world adds one ticket already delivered by an earlier run, and one
        // genuinely new
        st.tickets.push({ ...tk('OLD-1', [], '02-old'), state: 'closed' })
        st.tickets.push({ ...tk('NEW-1', [], '03-new'), state: 'open' })
      }
    }
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 1 }, makeRespond(st))
    check(S, 'SA5b no error', !error, error && error.message)
    check(S, 'SA5b the delivered ticket was NOT re-dispatched', !dispatched.includes('OLD-1'), dispatched.join(','))
    check(S, 'SA5b it never entered the schedule at all', !result.results.some((r) => r.id === 'OLD-1'))
    check(S, 'SA5b the drop is REPORTED, not silent',
      Array.isArray(result.rescanDroppedClosed) && result.rescanDroppedClosed.includes('OLD-1'),
      JSON.stringify(result.rescanDroppedClosed))
    // the other direction, so the filter cannot be "fixed" by neutering the rescan
    eq(S, 'SA5b a genuinely new ticket is still picked up', statusOf(result, 'NEW-1'), 'delivered')
    // a rescan drop must be distinguishable from a launch-time drop
    check(S, 'SA5b launch-time drops are not conflated with rescan drops',
      !result.rescanDroppedClosed.includes('A-1') && !result.rescanDroppedClosed.includes('A-2'))
  }

  // ---- SA5c (issue #151): post-run cleanup of ticket branches and run worktrees.
  // A leftover ticket branch is what later opens a merge request that REVERTS the default
  // branch — four such MRs, one of them -12,095 lines, all conflict-free, sat open in a
  // real repo and were found only because a human scrolled the list.
  {
    const tickets = [tk('A-1', [], 'x'), tk('A-2', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    let cleanupPrompt = ''
    const respond = async (a) => {
      if (a.label === 'cleanup') {
        cleanupPrompt = a.prompt
        return { ok: true, worktreesPruned: true, branchesDeleted: ['ticket/A-1', 'ticket/A-2'], branchesKept: [] }
      }
      return makeRespond(st)(a)
    }
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 0 }, respond)
    check(S, 'SA5c no error', !error, error && error.message)
    check(S, 'SA5c a cleanup step runs after the tickets', !!cleanupPrompt)
    check(S, 'SA5c it names only the DELIVERED ticket ids', /A-1, A-2/.test(cleanupPrompt), cleanupPrompt.slice(0, 200))
    check(S, 'SA5c it explains WHY, so it cannot be optimised away as tidying',
      /REVERTS the default branch/.test(cleanupPrompt))
    check(S, 'SA5c it forbids touching remote branches', /not delete any REMOTE branch/i.test(cleanupPrompt))
    check(S, 'SA5c the result is reported', result.cleanup && result.cleanup.branchesDeleted.length === 2)
  }

  // SA5d: cleanup that CANNOT complete must escalate. The entire failure mode of #151 is
  // that nothing reported anything, so a silent cleanup failure would reproduce it.
  {
    const tickets = [tk('A-1', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    const respond = async (a) => {
      if (a.label === 'cleanup') return { ok: true, worktreesPruned: false, branchesDeleted: [], branchesKept: ['ticket/A-1'] }
      return makeRespond(st)(a)
    }
    const { result } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 0 }, respond)
    check(S, 'SA5d an uncleaned branch escalates',
      result.escalations.some((e) => /cleanup could not remove/.test(e) && /ticket\/A-1/.test(e)),
      JSON.stringify(result.escalations))
    check(S, 'SA5d the escalation says what the risk actually is',
      result.escalations.some((e) => /reverts main/i.test(e)), JSON.stringify(result.escalations))
  }

  // SA5e: a cleanup agent that returns nothing is not silently treated as success.
  {
    const tickets = [tk('A-1', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    const respond = async (a) => (a.label === 'cleanup' ? null : makeRespond(st)(a))
    const { result } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 0 }, respond)
    check(S, 'SA5e a failed cleanup escalates rather than passing quietly',
      result.escalations.some((e) => /post-run cleanup did not complete/.test(e)),
      JSON.stringify(result.escalations))
    check(S, 'SA5e and the run still reports its tickets as delivered',
      statusOf(result, 'A-1') === 'delivered')
  }

  // ---- SA5f (issue #180): platform 'none' = local delivery, no forge on the critical path.
  {
    const tickets = [tk('A-1', [], 'x'), tk('A-2', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    let deliverPrompt = ''
    let rescanPrompt = ''
    const respond = async (a) => {
      if (kind(a.label) === 'deliver') deliverPrompt = a.prompt
      if (a.label.startsWith('rescan')) rescanPrompt = a.prompt
      if (a.label === 'cleanup') return { ok: true, worktreesPruned: true, branchesDeleted: [], branchesKept: [] }
      return makeRespond(st)(a)
    }
    const { result, error } = await drive(SRC,
      { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 1, platform: 'none' }, respond)
    check(S, 'SA5f no error', !error, error && error.message)
    check(S, 'SA5f delivery runs in local mode', /--delivery local/.test(deliverPrompt), deliverPrompt.slice(0, 300))
    // the two flags that would drag a forge back onto the critical path
    check(S, 'SA5f no --platform is passed', !/--platform/.test(deliverPrompt))
    check(S, 'SA5f no --issue is passed (there is no tracker)', !/--issue/.test(deliverPrompt))
    // the rescan must not publish, and must read the ledger for the SAME closed filter
    // It must not be told to RUN the publisher. Naming it inside a prohibition is correct
    // and wanted, so the assertion targets the command form, not the mere mention.
    check(S, 'SA5f the rescan is not told to run the publisher',
      !/run `node \.claude\/scripts\/publish-tickets\.mjs/.test(rescanPrompt))
    check(S, 'SA5f and it is explicitly forbidden from publishing',
      /Do NOT publish anything/.test(rescanPrompt))
    check(S, 'SA5f the rescan reads the local delivery ledger',
      /\.claude\/delivered\.json/.test(rescanPrompt), rescanPrompt.slice(0, 300))
    check(S, 'SA5f it must not report every ticket as open when the ledger is unreadable',
      /rather than reporting every ticket as "open"/.test(rescanPrompt))
    // the run hands the work over rather than hoarding it silently
    check(S, 'SA5f the run reports a local handoff', result.localHandoff && result.localHandoff.pushed === false)
    check(S, 'SA5f the handoff says nothing was pushed',
      result.localHandoff && result.localHandoff.next.some((l) => /Nothing was pushed/.test(l)))
    check(S, 'SA5f the handoff gives the exact push command',
      result.localHandoff && result.localHandoff.next.some((l) => l.includes('git push origin main')))
    eq(S, 'SA5f the tickets still delivered', statusOf(result, 'A-1'), 'delivered')
  }

  // SA5g: a tracker run is unaffected — no handoff, and the forge flags are still passed.
  // Without this, "local mode works" could be satisfied by making every run local.
  {
    const tickets = [tk('A-1', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    let deliverPrompt = ''
    const respond = async (a) => {
      if (kind(a.label) === 'deliver') deliverPrompt = a.prompt
      if (a.label === 'cleanup') return { ok: true, worktreesPruned: true, branchesDeleted: [], branchesKept: [] }
      return makeRespond(st)(a)
    }
    const { result } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 0, platform: 'gh' }, respond)
    check(S, 'SA5g a gh run still passes --platform', /--platform gh/.test(deliverPrompt))
    check(S, 'SA5g a gh run does NOT use local delivery', !/--delivery local/.test(deliverPrompt))
    check(S, 'SA5g a gh run reports no local handoff', result.localHandoff === null)
  }

  // SA5h: an unknown platform still fails loudly — 'none' widened the set, it did not
  // remove the check.
  {
    const tickets = [tk('A-1', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    const { error } = await drive(SRC, { tickets, mode: 'autonomous', platform: 'gitea' }, makeRespond(st))
    check(S, 'SA5h an unknown platform is rejected', !!error && /platform must be/.test(error.message), error && error.message)
  }

  // ---- SA5i (issue #183): a CLEAR carrying an UNMET acceptance row is not a CLEAR.
  //
  // A ticket was delivered with three [machine] rows unsatisfiable by inspection: the
  // Builder refused to implement them and documented why, and the Reviewer passed it
  // anyway. The shape is what makes it dangerous — a well-documented blocker reads like
  // diligence, and diligence reads like grounds to pass, so the better the disclosure the
  // safer a wrong CLEAR feels. This converts that judgement into a check.
  {
    const tickets = [tk('A-1', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    let delivered = false
    const respond = async (a) => {
      if (kind(a.label) === 'review') {
        return {
          verdict: 'CLEAR',
          checkedNote: 'Builder documented a blocker; work looks careful.',
          machineChecks: [
            { row: '[machine] npm test green', met: true },
            { row: '[machine] the new field serialises', met: false, note: 'field never added — contradicts a delivered ticket' },
          ],
        }
      }
      if (kind(a.label) === 'deliver') { delivered = true; return OK_DELIVERY }
      if (a.label === 'cleanup') return { ok: true, worktreesPruned: true, branchesDeleted: [], branchesKept: [] }
      return makeRespond(st)(a)
    }
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 0 }, respond)
    check(S, 'SA5i no error', !error, error && error.message)
    check(S, 'SA5i the ticket did NOT deliver', !delivered)
    eq(S, 'SA5i it is escalated, not delivered', statusOf(result, 'A-1'), 'escalated')
    const row = result.results.find((r) => r.id === 'A-1') || {}
    eq(S, 'SA5i the stage names the cause', row.stage, 'acceptance-unmet')
    check(S, 'SA5i the detail quotes the unmet row',
      /the new field serialises/.test(row.detail || ''), row.detail)
    check(S, 'SA5i and it carries the reason the reviewer gave',
      /contradicts a delivered ticket/.test(row.detail || ''), row.detail)
  }

  // SA5j: a CLEAR whose acceptance rows are all met still delivers. Without this, the
  // guard could be satisfied by rejecting every CLEAR, which would be worse than the bug.
  {
    const tickets = [tk('A-1', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    const respond = async (a) => {
      if (kind(a.label) === 'review') {
        return { verdict: 'CLEAR', checkedNote: 'ok', machineChecks: [{ row: '[machine] npm test green', met: true }] }
      }
      if (a.label === 'cleanup') return { ok: true, worktreesPruned: true, branchesDeleted: [], branchesKept: [] }
      return makeRespond(st)(a)
    }
    const { result } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 0 }, respond)
    eq(S, 'SA5j all rows met still delivers', statusOf(result, 'A-1'), 'delivered')
  }

  // SA5k: a reviewer that reports NO machineChecks is not punished — the field is new, and
  // an older reviewer definition must not stall every run. The guard fires on an explicit
  // `met: false`, which is the claim that matters.
  {
    const tickets = [tk('A-1', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    const respond = async (a) => {
      if (a.label === 'cleanup') return { ok: true, worktreesPruned: true, branchesDeleted: [], branchesKept: [] }
      return makeRespond(st)(a)
    }
    const { result } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 0 }, respond)
    eq(S, 'SA5k a verdict with no machineChecks still delivers', statusOf(result, 'A-1'), 'delivered')
  }

  // ---- SA6: reload cadence honors rescanEvery, and 0 disables it ----------------------
  {
    const mk = () => [tk('A-1', [], 'x'), tk('A-2', [], 'x'), tk('A-3', [], 'x'), tk('A-4', [], 'x'), tk('A-5', [], 'x'), tk('A-6', [], 'x')]
    const stA = { tickets: mk(), calls: 0 }
    const a = await drive(SRC, { tickets: mk(), mode: 'autonomous', concurrency: 1, rescanEvery: 3 }, makeRespond(stA))
    // 6 settles => 2 cadence reloads, plus one forced final check
    eq(S, 'SA6 rescanEvery=3 over 6 tickets => 2 cadence + 1 final reload', a.result && a.result.rescans, 3)

    const stB = { tickets: mk(), calls: 0 }
    const b = await drive(SRC, { tickets: mk(), mode: 'autonomous', concurrency: 1, rescanEvery: 0 }, makeRespond(stB))
    eq(S, 'SA6 rescanEvery=0 disables reloading entirely', b.result && b.result.rescans, 0)
    eq(S, 'SA6 static mode still delivers everything', b.result && b.result.delivered, 6)
  }

  // ---- SA7: the FINAL forced reload catches a ticket added after everything settled ---
  {
    const tickets = [tk('A-1', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    // added only once the original work is done — a cadence reload would never see it
    st.onScan = (n) => { if (n === 1) st.tickets.push(tk('LATE-1', [], 'x')) }
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 5 }, makeRespond(st))
    check(S, 'SA7 no error', !error, error && error.message)
    eq(S, 'SA7 a ticket added after the last settle still runs', statusOf(result, 'LATE-1'), 'delivered')
  }

  // ---- SA8: a late dependency change on already-dispatched work is NOT enforced -------
  {
    const tickets = [tk('A-1', [], 'x'), tk('A-2', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    st.onDeliver = (id) => {
      if (id !== 'A-1') return
      // retroactively claim A-1 was blocked by A-2 — it already ran
      st.tickets = st.tickets.map((t) => (t.id === 'A-1' ? { ...t, blockedBy: ['A-2'] } : t))
    }
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 1 }, makeRespond(st))
    check(S, 'SA8 no error', !error, error && error.message)
    eq(S, 'SA8 the already-delivered ticket stays delivered', statusOf(result, 'A-1'), 'delivered')
    check(S, 'SA8 the unenforceable edge is escalated, not silently applied',
      result && result.escalations.some((e) => /late dependency change on A-1/.test(e)))
  }

  // ---- SA9: a reload that introduces a cycle fails loudly -----------------------------
  {
    const tickets = [tk('A-1', [], 'x'), tk('C-1', [], 'x'), tk('C-2', ['C-1'], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    st.onDeliver = (id) => {
      if (id !== 'A-1') return
      st.tickets = st.tickets.map((t) => (t.id === 'C-1' ? { ...t, blockedBy: ['C-2'] } : t)) // C-1 <-> C-2
    }
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 1 }, makeRespond(st))
    check(S, 'SA9 no error (the run reports, it does not throw)', !error, error && error.message)
    eq(S, 'SA9 cycle member failed', statusOf(result, 'C-1'), 'failed')
    eq(S, 'SA9 other cycle member failed', statusOf(result, 'C-2'), 'failed')
    check(S, 'SA9 the cycle is named in the escalations',
      result && result.escalations.some((e) => /cycle/.test(e) && /C-1/.test(e) && /C-2/.test(e)))
  }

  // ---- SA10: a failed reload keeps the previous graph and finishes the work -----------
  {
    const tickets = [tk('A-1', [], 'x'), tk('A-2', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0, fail: true }
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 1 }, makeRespond(st))
    check(S, 'SA10 no error', !error, error && error.message)
    eq(S, 'SA10 in-flight work still completes on a broken scan', result && result.delivered, 2)
    check(S, 'SA10 the scan failure is escalated with its reason',
      result && result.escalations.some((e) => /kept the previous graph/.test(e) && /half-written ticket/.test(e)))
  }

  // ---- SA11: a ticket deleted while still pending is dropped from the run -------------
  {
    const tickets = [tk('A-1', [], 'x'), tk('DOOMED', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    st.onDeliver = (id) => { if (id === 'A-1') st.tickets = st.tickets.filter((t) => t.id !== 'DOOMED') }
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 1 }, makeRespond(st))
    check(S, 'SA11 no error', !error, error && error.message)
    eq(S, 'SA11 the deleted pending ticket is gone from the results', result && result.results.some((r) => r.id === 'DOOMED'), false)
    eq(S, 'SA11 the surviving ticket delivered', statusOf(result, 'A-1'), 'delivered')
  }

  // ---- SA12: runaway guards ----------------------------------------------------------
  {
    const tickets = [tk('A-1', [], 'x')]
    const st = { tickets: tickets.slice(), calls: 0 }
    let n = 0
    st.onScan = () => { n += 1; st.tickets.push(tk('GROW-' + n, [], 'x')) } // grows forever
    const { result, error } = await drive(SRC, { tickets, mode: 'autonomous', concurrency: 1, rescanEvery: 1, maxTickets: 4 }, makeRespond(st))
    check(S, 'SA12 no error', !error, error && error.message)
    check(S, 'SA12 growth stops at maxTickets', result && result.ticketCount <= 4)
    check(S, 'SA12 the refusal is escalated', result && result.escalations.some((e) => /maxTickets/.test(e)))
  }

  // ---- SA13: validation ---------------------------------------------------------------
  {
    const bad = async (args, why) => {
      const { error } = await drive(SRC, args, makeRespond({ tickets: [], calls: 0 }))
      check(S, 'SA13 rejects ' + why, !!error, 'expected a throw')
    }
    await bad({ tickets: [], mode: 'autonomous' }, 'an empty ticket list')
    await bad({ tickets: [tk('A-1')], mode: 'nope' }, 'an unknown mode')
    await bad({ tickets: [tk('A-1')], mode: 'autonomous', concurrency: 0 }, 'concurrency < 1')
    await bad({ tickets: [tk('A-1')], mode: 'autonomous', rescanEvery: -1 }, 'a negative rescanEvery')
    await bad({ tickets: [{ id: 'A-1' }], mode: 'autonomous' }, 'a ticket without a path')
    await bad({ tickets: [{ id: 'A-1', path: 'p', blockedBy: 'A-2' }], mode: 'autonomous' }, 'a non-array blockedBy')
  }

  // ---- SA14: PARITY with run-milestone on identical static input ----------------------
  // The maintainer accepted duplicating the dispatch loop across two workflow files.
  // This is the guard: same tickets, same failures, same outcomes.
  {
    const scenarios = [
      { name: 'happy chain', tickets: [tk('A-1', []), tk('A-2', ['A-1']), tk('A-3', ['A-2'])], failAt: null },
      { name: 'diamond with a failure', tickets: [tk('A-1', []), tk('A-2', ['A-1']), tk('A-3', ['A-1']), tk('A-4', ['A-2'])], failAt: 'A-2' },
      { name: 'independent branches', tickets: [tk('A-1', []), tk('B-1', []), tk('B-2', ['B-1'])], failAt: 'A-1' },
    ]
    for (const sc of scenarios) {
      const mkRespond = () => {
        const st = { tickets: sc.tickets.slice(), calls: 0 }
        const base = makeRespond(st)
        return async (c) => (sc.failAt && c.id === sc.failAt && kind(c.label) === 'build'
          ? { branch: 'ticket/' + c.id, testsPassed: false, testOutput: 'RED' }
          : base(c))
      }
      const g = await drive(SRC, { tickets: sc.tickets, mode: 'autonomous', concurrency: 2, rescanEvery: 0 }, mkRespond())
      const m = await drive(RUNMILESTONE, { tickets: sc.tickets, mode: 'autonomous', concurrency: 2 }, mkRespond())
      check(S, `SA14 [${sc.name}] neither scheduler errored`, !g.error && !m.error, (g.error || m.error || {}).message)
      const norm = (res) => (res.results || []).slice().sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.id + '=' + r.status).join(',')
      eq(S, `SA14 [${sc.name}] start-all and run-milestone agree per ticket`, norm(g.result || {}), norm(m.result || {}))
    }
  }

  // ---- SA15: concurrency sweep on a realistic 24-ticket / 6-module PRD ----------------
  // Maintainer request: prove the whole thing runs at 1, 2, 4 and 6 lanes. This is the
  // Level-0 half — the ACTUAL scheduler, stubbed agents, zero tokens. It cannot catch
  // anything that only fails with real agents (see the pattern's Level-1 rehearsal), but
  // every scheduler-level bug lives here: lost tickets, a ticket dispatched before its
  // blocker, the cap being exceeded, or lanes silently never filling.
  {
    const P = []
    const add = (mod, id, deps) => P.push(tk(id, deps, mod))
    // 01-core: two independent chains converging (max width 2)
    add('01-core', '0101', []); add('01-core', '0102', [])
    add('01-core', '0103', ['0101']); add('01-core', '0104', ['0102'])
    add('01-core', '0105', ['0103', '0104'])
    // 02-api: 4-wide fan-out off core, each with a test ticket behind it
    add('02-api', '0201', ['0105']); add('02-api', '0202', ['0105'])
    add('02-api', '0203', ['0105']); add('02-api', '0204', ['0105'])
    add('02-api', '0205', ['0201']); add('02-api', '0206', ['0202']); add('02-api', '0207', ['0203'])
    // 03-ui: depends on the api surface, 3 independent screens then an integration pass
    add('03-ui', '0301', ['0205']); add('03-ui', '0302', ['0206']); add('03-ui', '0303', ['0207'])
    add('03-ui', '0304', ['0301', '0302', '0303'])
    // 05-jobs: one long serial chain, independent of everything else
    add('05-jobs', '0501', []); add('05-jobs', '0502', ['0501'])
    add('05-jobs', '0503', ['0502']); add('05-jobs', '0504', ['0503'])
    // 06-extra + 07-more: free-floating work with no blockers at all
    add('06-extra', '0601', []); add('06-extra', '0602', [])
    add('07-more', '0701', []); add('07-more', '0702', ['0701'])

    eq(S, 'SA15 fixture is 24 tickets across 6 modules', P.length, 24)
    const depMap = Object.fromEntries(P.map((t) => [t.id, t.blockedBy || []]))

    for (const c of [1, 2, 4, 6]) {
      const st = { tickets: P.slice(), calls: 0 }
      const r = await drive(SRC, { tickets: P, mode: 'autonomous', concurrency: c, rescanEvery: 0 }, makeRespond(st))

      check(S, `SA15 c=${c} no error`, !r.error, r.error && r.error.message)
      const delivered = (r.result && r.result.results || []).filter((x) => x.status === 'delivered').length
      eq(S, `SA15 c=${c} all 24 tickets delivered`, delivered, 24)

      // the cap is a cap: never more tickets in flight than asked for
      check(S, `SA15 c=${c} never exceeded the lane cap (saw ${r.maxLanes})`, r.maxLanes <= c)
      // and it is actually USED: with >=6 independent tickets available at the start,
      // every level here should saturate. A cap that never fills means work is being
      // serialized for a reason the DAG does not justify.
      eq(S, `SA15 c=${c} lanes actually saturated`, r.maxLanes, c)

      // the invariant that matters most: nothing ever started before a blocker finished
      const violations = []
      for (const [id, deps] of Object.entries(depMap)) {
        for (const d of deps) {
          if (!(r.deliverEnd[d] < r.firstStart[id])) violations.push(`${id} started before ${d} delivered`)
        }
      }
      eq(S, `SA15 c=${c} no ticket started before its blocker delivered`, violations.join('; '), '')
    }

    // More lanes must not change the OUTCOME, only the timing — a scheduler that drops
    // or reorders work under load would show up here as a differing result set.
    const outcomes = []
    for (const c of [1, 2, 4, 6]) {
      const st = { tickets: P.slice(), calls: 0 }
      const r = await drive(SRC, { tickets: P, mode: 'autonomous', concurrency: c, rescanEvery: 0 }, makeRespond(st))
      outcomes.push((r.result.results || []).slice().sort((a, b) => a.id.localeCompare(b.id)).map((x) => x.id + '=' + x.status).join(','))
    }
    eq(S, 'SA15 concurrency 1/2/4/6 all produce identical outcomes', new Set(outcomes).size, 1)
  }
}
