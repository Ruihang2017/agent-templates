// RB-1 — insert `-` before each interior capital (a capital preceded by a lowercase letter or
// digit, i.e. the camelCase hump), lowercase everything, then collapse whitespace runs into a
// single `-`. Pure and side-effect free: the module body is one function declaration, and the
// regex literals stay inline so no `lastIndex` state is shared.
export function kebab (input) {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/\s+/g, '-')
}
