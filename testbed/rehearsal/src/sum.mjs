// RB-3 — add up the elements of `nums`, rejecting any element that is not a finite number. Pure
// and side-effect free: the module body is one function declaration, so importing it does nothing.
// Each element is checked before it is added, so a non-number never reaches the total; the running
// total lives inside the function and starts at 0, which is what makes `sum([])` return 0.
// `Number.isFinite` (not the global `isFinite`) is the predicate, so no coercion happens: a string,
// a boolean or `null` throws rather than being quietly added.
export function sum (nums) {
  let total = 0
  for (const n of nums) {
    if (!Number.isFinite(n)) throw new TypeError(`sum: every element must be a finite number, got ${String(n)}`)
    total += n
  }
  return total
}
