import { describe, expect, it } from 'vitest';
import {
  collectResults,
  err,
  flatMapResult,
  isErr,
  isOk,
  mapError,
  mapResult,
  ok,
  unwrapOr,
} from './result.js';

describe('Result', () => {
  it('ok and err construct discriminated values', () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
    expect(err('bad')).toEqual({ ok: false, error: 'bad' });
  });

  it('isOk and isErr discriminate', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isOk(err('x'))).toBe(false);
    expect(isErr(err('x'))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
  });

  it('mapResult transforms only the success value', () => {
    expect(mapResult(ok(2), (value) => value * 5)).toEqual(ok(10));
    expect(mapResult(err('keep'), (value: number) => value * 5)).toEqual(err('keep'));
  });

  it('flatMapResult chains and short-circuits on error', () => {
    const halveEven = (value: number) => (value % 2 === 0 ? ok(value / 2) : err('odd'));
    expect(flatMapResult(ok(8), halveEven)).toEqual(ok(4));
    expect(flatMapResult(ok(7), halveEven)).toEqual(err('odd'));
    expect(flatMapResult(err('upstream'), halveEven)).toEqual(err('upstream'));
  });

  it('mapError transforms only the error value', () => {
    expect(mapError(err(1), (code) => code + 1)).toEqual(err(2));
    expect(mapError(ok('value'), (code: number) => code + 1)).toEqual(ok('value'));
  });

  it('unwrapOr returns the value or the fallback', () => {
    expect(unwrapOr(ok(9), 0)).toBe(9);
    expect(unwrapOr(err('e'), 0)).toBe(0);
  });

  it('collectResults returns the first error or all values in order', () => {
    expect(collectResults([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
    expect(collectResults([ok(1), err('boom'), ok(3)])).toEqual(err('boom'));
  });
});
