/**
 * Borsh integer range checks for the encode boundary. The DataView integer writers (setUint,
 * setInt, setBigUint64, setBigInt64) silently WRAP an out-of-range value (verified on Node:
 * setInt32(3e9) gives a negative i32, setBigUint64(-1n) gives 0xffff_ffff_ffff_ffff, no throw).
 * At this trust boundary a wrong-width value must fail loudly as a Result error rather than
 * encode a different number than intended (which would only surface as an on-chain settle
 * revert much later), so every scalar is range-checked against its on-chain width before it is
 * written. sourceRef: programs/agent_ledger/src/state.rs (field widths).
 */

export type EncodeError =
  | { readonly kind: 'bad-length'; readonly field: string; readonly detail: string }
  | { readonly kind: 'bad-range'; readonly field: string; readonly detail: string };

/** A 32-byte fixed array came in the wrong length (hash, pubkey, root). */
export const badLength = (field: string, actual: number): EncodeError => ({
  kind: 'bad-length',
  field,
  detail: `expected 32 bytes, got ${actual}`,
});

const U8_MAX = 0xff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

const outOfRange = (
  field: string,
  value: number | bigint,
  low: string,
  high: string,
  typeName: string,
): EncodeError => ({
  kind: 'bad-range',
  field,
  detail: `${field}=${value} is not ${typeName} in [${low}, ${high}]`,
});

export const checkU8 = (value: number, field: string): EncodeError | null =>
  Number.isInteger(value) && value >= 0 && value <= U8_MAX
    ? null
    : outOfRange(field, value, '0', String(U8_MAX), 'a u8');

export const checkU16 = (value: number, field: string): EncodeError | null =>
  Number.isInteger(value) && value >= 0 && value <= U16_MAX
    ? null
    : outOfRange(field, value, '0', String(U16_MAX), 'a u16');

export const checkU32 = (value: number, field: string): EncodeError | null =>
  Number.isInteger(value) && value >= 0 && value <= U32_MAX
    ? null
    : outOfRange(field, value, '0', String(U32_MAX), 'a u32');

export const checkI32 = (value: number, field: string): EncodeError | null =>
  Number.isInteger(value) && value >= I32_MIN && value <= I32_MAX
    ? null
    : outOfRange(field, value, String(I32_MIN), String(I32_MAX), 'an i32');

export const checkU64 = (value: bigint, field: string): EncodeError | null =>
  value >= 0n && value <= U64_MAX
    ? null
    : outOfRange(field, value, '0', String(U64_MAX), 'a u64');

export const checkI64 = (value: bigint, field: string): EncodeError | null =>
  value >= I64_MIN && value <= I64_MAX
    ? null
    : outOfRange(field, value, String(I64_MIN), String(I64_MAX), 'an i64');

/** A 1X2 side / claimed result is exactly 0 (home), 1 (draw), or 2 (away). sourceRef:
 * programs/agent_ledger/src/state.rs (SIDE_HOME/SIDE_DRAW/SIDE_AWAY). */
export const checkSide = (value: number, field: string): EncodeError | null =>
  value === 0 || value === 1 || value === 2
    ? null
    : { kind: 'bad-range', field, detail: `${field}=${value} must be 0 (home), 1 (draw), or 2 (away)` };
