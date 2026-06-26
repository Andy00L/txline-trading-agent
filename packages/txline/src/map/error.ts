/** Failure modes when mapping a raw API payload into a domain event. */
export type MapError =
  | { readonly kind: 'odds-array-mismatch'; readonly detail: string }
  | { readonly kind: 'invalid-odds'; readonly detail: string }
  | { readonly kind: 'malformed-pct'; readonly detail: string };
