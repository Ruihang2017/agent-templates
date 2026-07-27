// RA-2 — uppercase the first letter of every whitespace-separated word and leave the rest of
// each word untouched. Pure and side-effect free: the module body is one function declaration,
// and the regex literal stays inline so no `lastIndex` state is shared.
export function titleCase (input) {
  return input.replace(/\S+/g, (word) => word[0].toUpperCase() + word.slice(1))
}
