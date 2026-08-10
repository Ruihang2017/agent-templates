// The global file firewall — the deterministic half of this pattern's safety story.
//
// Spokes run at LOW reasoning effort in parallel worktrees. Two things must never be
// left to their judgement:
//
//   1. Dependency / lock / infra files. If two spokes both add a dependency, the merge
//      conflict lands in a generated lockfile and is not mechanically resolvable. So no
//      spoke may touch one, EVER — not even when its own brief says it may. A brief that
//      genuinely needs a new dependency is a brief the hub must handle itself.
//   2. Files outside the brief's declared file-scope. That is what makes concurrent
//      worktrees safe: disjoint write-sets, checked rather than assumed.
//
// Both checks run AFTER the spoke finishes, against `git diff --name-only`, so they audit
// what actually happened rather than what the spoke was told to do. Nothing here depends
// on the hub's opinion of its own work — which matters, because in this pattern the hub
// reviews the diff it commissioned (pattern README section 4).
//
// Fail-closed by construction: an empty, missing, or unparseable scope does not mean
// "anything goes", it means NOTHING is in scope. The permissive reading of a broken brief
// is exactly how a wide-open spoke ships.

/**
 * Paths a spoke may never write, whatever its brief says.
 *
 * An entry containing no `/` matches by BASENAME at any depth, so `package.json` also
 * catches `services/api/package.json`. An entry containing `/` is matched as a path glob
 * against the full repo-relative path.
 *
 * Deliberately covers several ecosystems at once: this pattern's whole premise is that
 * the driver is language-agnostic, so the firewall cannot be either.
 */
export const DEFAULT_DENY = [
  // JS / TS
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  // Python
  'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile', 'Pipfile.lock', 'uv.lock',
  // Go / Rust / Ruby / PHP / Java / .NET
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock',
  'composer.json', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gradle.lockfile',
  // container / infra / CI — an executor changing how the project BUILDS or DEPLOYS is
  // always an escalation, never a task detail
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore',
  '.github/workflows/**', '.gitlab-ci.yml', 'Makefile',
  // the agent harness itself — a spoke rewriting its own instructions or its own
  // permissions is the one failure this scaffold cannot audit its way out of
  '.claude/**', 'AGENTS.md', 'CLAUDE.md',
  // secrets
  '.env', '.env.*', '.npmrc', '.netrc',
]

/**
 * Minimal glob matcher: `**` spans path separators, `*` does not, `?` is one non-slash
 * character, everything else is literal. Deliberately dependency-free — this runs inside
 * a freshly created worktree with no install step.
 *
 * Scanned character by character rather than by a chain of .replace() calls: a replace
 * chain rewrites its own output, so `src/**` collapses into a pattern matching only the
 * bare directory, and every file under it silently reads as out-of-scope.
 */
export function globMatch(pattern, path) {
  let rx = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` may also match zero segments, so `a/**/b.js` covers `a/b.js` too
        if (pattern[i + 2] === '/') { rx += '(?:.*/)?'; i += 2 } else { rx += '.*'; i += 1 }
      } else rx += '[^/]*'
    } else if (c === '?') rx += '[^/]'
    else rx += c.replace(/[.+^${}()|[\]\\]/, '\\$&')
  }
  return new RegExp('^' + rx + '$').test(path)
}

const basename = (p) => p.slice(p.lastIndexOf('/') + 1)

/** True when `path` is denied outright, whatever any brief says. */
export function isDenied(path, deny = DEFAULT_DENY) {
  return deny.some((d) => (d.includes('/') ? globMatch(d, path) : globMatch(d, basename(path))))
}

/**
 * Audit the paths a spoke actually changed.
 *
 * @param {string[]} changed  repo-relative paths, e.g. from `git diff --name-only`
 * @param {{scope?: string[], deny?: string[]}} opts
 *        scope — the brief's declared write-set (globs). Missing/empty means nothing is
 *        allowed, not everything.
 * @returns {{ok: boolean, denied: string[], outOfScope: string[]}}
 *
 * `denied` and `outOfScope` are reported separately because they mean different things to
 * the hub: a denied path is an escalation (the brief was mis-specified and only the hub
 * may act on it), an out-of-scope path is a decomposition error (two briefs contend, or
 * the scope was written too narrow). Collapsing them into one violation count would lose
 * the distinction the hub needs in order to decide what to do next.
 *
 * Order matters: deny is checked FIRST, so a scope that grants `**` — by accident or by a
 * spoke's own editing — cannot launder a lockfile change into an in-scope one.
 */
export function auditPaths(changed, opts = {}) {
  const deny = opts.deny || DEFAULT_DENY
  const scope = Array.isArray(opts.scope) ? opts.scope.filter((s) => typeof s === 'string' && s.trim()) : []
  const denied = []
  const outOfScope = []
  for (const raw of changed || []) {
    const path = String(raw).trim().replace(/^\.\//, '')
    if (!path) continue
    if (isDenied(path, deny)) { denied.push(path); continue }
    // fail-closed: with no usable scope, `scope.some(...)` is false for every path, so
    // everything lands in outOfScope. That is the intended behaviour, not an oversight.
    if (!scope.some((g) => globMatch(g, path))) outOfScope.push(path)
  }
  return { ok: denied.length === 0 && outOfScope.length === 0, denied, outOfScope }
}
