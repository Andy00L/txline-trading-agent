import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('reduces a keyed Helius RPC URL to scheme and host', () => {
    const leak = 'fetch failed: POST https://devnet.helius-rpc.com/?api-key=secret-key-123 (timeout)';
    const redacted = redactSecrets(leak);
    expect(redacted).not.toContain('secret-key-123');
    expect(redacted).toContain('https://devnet.helius-rpc.com/[redacted]');
    expect(redacted).toContain('(timeout)');
  });

  it('strips an API key embedded in the URL path (QuickNode/Alchemy style)', () => {
    const leak = 'error from https://solana-devnet.g.alchemy.com/v2/AbC123secretKEY/';
    const redacted = redactSecrets(leak);
    expect(redacted).not.toContain('AbC123secretKEY');
    expect(redacted).toContain('https://solana-devnet.g.alchemy.com/[redacted]');
  });

  it('strips userinfo credentials from a URL', () => {
    const redacted = redactSecrets('https://user:pass@rpc.example.com/path?x=1');
    expect(redacted).not.toContain('user:pass');
    expect(redacted).not.toContain('pass@');
    expect(redacted).toContain('https://rpc.example.com/[redacted]');
  });

  it('masks a bare api-key token outside a URL', () => {
    const redacted = redactSecrets('config error: api-key=abcdef not accepted');
    expect(redacted).not.toContain('abcdef');
    expect(redacted).toContain('api-key=[redacted]');
  });

  it('leaves a message with no secret unchanged', () => {
    expect(redactSecrets('rate limited (429)')).toBe('rate limited (429)');
  });
});
