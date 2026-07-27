// RA-6 — clamp `size` into the inclusive range [1, maxSize], then chunk `items` by that value.
// Pure and side-effect free: the module body declares one function and imports two modules
// that are themselves side-effect free. Import only — nothing here is re-exported.
// The clamp runs first, so the size handed to `chunk` is always at least 1.
import { clamp } from '../src/clamp.mjs'
import { chunk } from '../src/chunk.mjs'

export function paginate (items, size, maxSize) {
  return chunk(items, clamp(size, 1, maxSize))
}
