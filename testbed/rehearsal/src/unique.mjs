// RB-4 — return a new array with duplicates removed, preserving first-seen order. Pure and
// side-effect free: the module body is one function declaration, so importing it does nothing.
// A Set keeps insertion order, so first-seen order is correct by construction, and the spread
// always allocates a fresh array, so the caller's array is neither returned nor mutated.
export function unique (items) {
  return [...new Set(items)]
}
