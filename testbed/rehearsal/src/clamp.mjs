// RA-3 — bound `n` to the inclusive range [lo, hi], rejecting an inverted range. Pure and
// side-effect free: the module body is one function declaration, so importing it does nothing.
// The range check runs first, so an inverted range throws instead of being silently bounded.
export function clamp (n, lo, hi) {
  if (lo > hi) throw new RangeError(`clamp: lo (${lo}) must not exceed hi (${hi})`)
  return Math.min(Math.max(n, lo), hi)
}
