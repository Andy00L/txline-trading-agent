/** Failure modes for the pure quant functions. Errors are values. */
export type QuantError =
  | { readonly kind: 'empty-market' }
  | { readonly kind: 'degenerate-book'; readonly detail: string }
  | { readonly kind: 'no-convergence'; readonly detail: string }
  | { readonly kind: 'invalid-config'; readonly detail: string }
  | { readonly kind: 'empty-sample' };
