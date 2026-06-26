import { err, ok, type Result } from '@txline-agent/core';
import type { z } from 'zod';

/** A schema validation failure at an ingress boundary. Carries the failing field
 * path and message; never carries the raw payload, so it is safe to log. */
export type ParseError = {
  readonly kind: 'schema';
  readonly field: string;
  readonly message: string;
};

/**
 * Parse untrusted JSON from a TxLINE response or SSE frame into a typed value,
 * returning a Result rather than throwing. On failure it reports the first failing
 * field path. sourceRef: docs/BUILD_PLAN.md ("zod at every ingress").
 */
export const parseWith = <TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  raw: unknown,
): Result<z.infer<TSchema>, ParseError> => {
  const result = schema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  const issue = result.error.issues[0];
  return err({
    kind: 'schema',
    field: issue ? issue.path.join('.') || '(root)' : '(root)',
    message: issue ? issue.message : 'invalid payload',
  });
};
