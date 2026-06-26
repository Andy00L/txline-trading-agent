/**
 * Errors as values. Business logic returns a Result instead of throwing; callers
 * branch on `ok`. The only `throw` allowed in this codebase is the outer CLI
 * boundary. sourceRef: docs/BUILD_PLAN.md ("errors-as-values end to end") and
 * .claude/SKILL_GENERAL.md section 5.
 */

export type Ok<TValue> = { readonly ok: true; readonly value: TValue };
export type Err<TError> = { readonly ok: false; readonly error: TError };
export type Result<TValue, TError> = Ok<TValue> | Err<TError>;

export const ok = <TValue>(value: TValue): Ok<TValue> => ({ ok: true, value });
export const err = <TError>(error: TError): Err<TError> => ({ ok: false, error });

export const isOk = <TValue, TError>(result: Result<TValue, TError>): result is Ok<TValue> =>
  result.ok;

export const isErr = <TValue, TError>(result: Result<TValue, TError>): result is Err<TError> =>
  !result.ok;

/** Transform the success value; an error passes through untouched. */
export const mapResult = <TValue, TError, TNext>(
  result: Result<TValue, TError>,
  transform: (value: TValue) => TNext,
): Result<TNext, TError> => (result.ok ? ok(transform(result.value)) : result);

/** Chain a fallible step; an error short-circuits. */
export const flatMapResult = <TValue, TError, TNext>(
  result: Result<TValue, TError>,
  transform: (value: TValue) => Result<TNext, TError>,
): Result<TNext, TError> => (result.ok ? transform(result.value) : result);

/** Transform the error value; a success passes through untouched. */
export const mapError = <TValue, TError, TNextError>(
  result: Result<TValue, TError>,
  transform: (error: TError) => TNextError,
): Result<TValue, TNextError> => (result.ok ? result : err(transform(result.error)));

/** Unwrap the success value or fall back to a default. Pure, never throws. */
export const unwrapOr = <TValue, TError>(
  result: Result<TValue, TError>,
  fallback: TValue,
): TValue => (result.ok ? result.value : fallback);

/**
 * Collect a list of Results into a Result of a list. Returns the first error
 * encountered (left to right), otherwise all values in order.
 */
export const collectResults = <TValue, TError>(
  results: readonly Result<TValue, TError>[],
): Result<TValue[], TError> => {
  const values: TValue[] = [];
  for (const result of results) {
    if (!result.ok) {
      return result;
    }
    values.push(result.value);
  }
  return ok(values);
};
