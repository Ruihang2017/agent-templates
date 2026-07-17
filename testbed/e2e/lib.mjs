// Minimal check/report helpers shared by the E2E suites. No framework on purpose:
// `node testbed/e2e/run-e2e.mjs` must work on a bare Node >= 18 install.

export const results = []

export function check(suite, label, cond, detail = '') {
  const pass = Boolean(cond)
  results.push({ suite, label, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  [${suite}] ${label}${pass || !detail ? '' : ' — ' + detail}`)
  return pass
}

export function eq(suite, label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  return check(suite, label, pass, pass ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

export function summarize() {
  const failed = results.filter((r) => !r.pass)
  console.log('')
  console.log(`E2E: ${results.length - failed.length}/${results.length} checks passed`)
  for (const f of failed) console.log(`  FAIL [${f.suite}] ${f.label}${f.detail ? ' — ' + f.detail : ''}`)
  return failed.length === 0
}
