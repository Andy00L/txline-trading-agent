/** A parsed Server-Sent Events frame. Fields are present only when the frame
 * carried them. sourceRef: WHATWG HTML "Server-sent events" field parsing. */
export type SseFrame = {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
};

const parseFrame = (raw: string): SseFrame | null => {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      continue; // blank line within a frame, or a comment
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'id') {
      id = value;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (id === undefined && event === undefined && dataLines.length === 0) {
    return null;
  }
  const frame: { id?: string; event?: string; data?: string } = {};
  if (id !== undefined) {
    frame.id = id;
  }
  if (event !== undefined) {
    frame.event = event;
  }
  if (dataLines.length > 0) {
    frame.data = dataLines.join('\n');
  }
  return frame;
};

/**
 * Incremental SSE parser: feed it text chunks, it returns the frames completed by
 * each chunk and buffers the remainder. Pure and deterministic. Frames are
 * separated by a blank line; CRLF is normalized to LF.
 */
export class SseFrameParser {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const frames: SseFrame[] = [];
    let separator = this.buffer.indexOf('\n\n');
    while (separator >= 0) {
      const rawFrame = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const frame = parseFrame(rawFrame);
      if (frame) {
        frames.push(frame);
      }
      separator = this.buffer.indexOf('\n\n');
    }
    return frames;
  }
}
