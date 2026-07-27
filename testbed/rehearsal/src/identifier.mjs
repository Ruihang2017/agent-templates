// RB-5 — kebab-case the input, then camel-case that result. Pure and side-effect free: the
// module body declares one function and imports two modules that are themselves side-effect
// free. Import only — nothing here is re-exported. This composes; it does not filter: whatever
// `kebab` and `camel` leave alone passes straight through to the output.
import { kebab } from '../src/kebab.mjs'
import { camel } from '../src/camel.mjs'

export function identifier (input) {
  return camel(kebab(input))
}
