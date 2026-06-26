import { describe, expect, it } from 'vitest';
import { SseFrameParser } from './sse-parse.js';

describe('SseFrameParser', () => {
  it('parses a data frame with an id', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('id: 100:0\ndata: {"x":1}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: '100:0', data: '{"x":1}' });
  });

  it('parses a heartbeat event frame', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('event: heartbeat\ndata: {"Ts":123}\n\n');
    expect(frames[0]).toEqual({ event: 'heartbeat', data: '{"Ts":123}' });
  });

  it('buffers a partial frame across chunks', () => {
    const parser = new SseFrameParser();
    expect(parser.push('data: hel')).toHaveLength(0);
    const frames = parser.push('lo\n\n');
    expect(frames[0]).toEqual({ data: 'hello' });
  });

  it('joins multi-line data and normalizes CRLF', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('data: a\r\ndata: b\r\n\r\n');
    expect(frames[0]).toEqual({ data: 'a\nb' });
  });

  it('ignores comment lines', () => {
    const parser = new SseFrameParser();
    const frames = parser.push(': keep-alive\ndata: x\n\n');
    expect(frames[0]).toEqual({ data: 'x' });
  });
});
