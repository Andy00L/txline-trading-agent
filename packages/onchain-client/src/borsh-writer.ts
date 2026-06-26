/**
 * Minimal borsh writer for the fixed set of scalar and byte types the agent_ledger
 * instructions use. Little-endian integers, 1-byte bools, fixed byte arrays written
 * raw, and vectors as a u32 length prefix followed by their elements. Matched against
 * the Rust borsh output by golden tests.
 */
export class BorshWriter {
  private readonly parts: Uint8Array[] = [];

  private scalar(size: number, write: (view: DataView) => void): void {
    const buffer = new Uint8Array(size);
    write(new DataView(buffer.buffer));
    this.parts.push(buffer);
  }

  u8(value: number): void {
    this.scalar(1, (view) => view.setUint8(0, value));
  }

  u16(value: number): void {
    this.scalar(2, (view) => view.setUint16(0, value, true));
  }

  u32(value: number): void {
    this.scalar(4, (view) => view.setUint32(0, value, true));
  }

  i32(value: number): void {
    this.scalar(4, (view) => view.setInt32(0, value, true));
  }

  u64(value: bigint): void {
    this.scalar(8, (view) => view.setBigUint64(0, value, true));
  }

  i64(value: bigint): void {
    this.scalar(8, (view) => view.setBigInt64(0, value, true));
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  /** Append fixed bytes raw (no length prefix), for example a 32-byte hash. */
  bytes(value: Uint8Array): void {
    this.parts.push(value);
  }

  /** Borsh vector length prefix (u32). */
  vecLen(length: number): void {
    this.u32(length);
  }

  finish(): Uint8Array {
    const total = this.parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}
