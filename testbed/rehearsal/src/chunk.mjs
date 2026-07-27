// RA-4 — split `items` into consecutive arrays of at most `size` elements. Pure and side-effect
// free: the module body is one function declaration, so importing it does nothing.
// The size guard runs first, so an unusable size throws instead of looping forever, and `slice`
// copies, so the caller's array is never mutated and the chunks never alias it.
export function chunk (items, size) {
  if (size < 1) throw new RangeError(`chunk: size (${size}) must be at least 1`)
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
