/** Keep an explicit choice; otherwise select only an unambiguous option. */
export function singleOptionValue(values: readonly string[], selected: string): string {
  if (values.includes(selected)) return selected;
  return values.length === 1 ? values[0]! : "";
}
