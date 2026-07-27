// RB-2 — convert a kebab-case string to camelCase: drop each `-` and uppercase the letter that
// follows, leaving every other character (including the first) untouched. Pure and side-effect
// free: the module body is one function declaration, and the regex literal stays inline so no
// `lastIndex` state is shared.
export function camel (input) {
  return input.replace(/-(.)/g, (_, next) => next.toUpperCase())
}
