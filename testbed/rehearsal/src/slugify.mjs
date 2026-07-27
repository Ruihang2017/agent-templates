// RA-1 — lowercase, collapse every run of non-alphanumeric characters into a single `-`,
// then trim leading/trailing `-`. Pure and side-effect free: the module body is one function
// declaration, and the regex literals stay inline so no `lastIndex` state is shared.
export function slugify (input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
