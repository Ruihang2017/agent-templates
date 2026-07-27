// RB-6 — de-duplicate `nums`, then divide their sum by the de-duplicated count. Pure and
// side-effect free: the module body declares one function and imports two modules that are
// themselves side-effect free. Import only — nothing here is re-exported.
// The de-duplicated array is bound once and used for both the numerator and the denominator,
// so the two can never drift apart. The empty check runs before the division, which is what
// keeps `0 / 0` from producing NaN when there is nothing to average.
import { sum } from '../src/sum.mjs'
import { unique } from '../src/unique.mjs'

export function average (nums) {
  const distinct = unique(nums)
  if (distinct.length === 0) return 0
  return sum(distinct) / distinct.length
}
