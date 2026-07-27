// RA-5 — slugify the input, turn every `-` back into a space, then title-case the result.
// Pure and side-effect free: the module body declares one function and imports two modules
// that are themselves side-effect free. Import only — nothing here is re-exported.
import { slugify } from '../src/slugify.mjs'
import { titleCase } from '../src/title-case.mjs'

export function headline (input) {
  return titleCase(slugify(input).replaceAll('-', ' '))
}
