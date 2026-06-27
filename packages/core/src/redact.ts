/**
 * Redact secrets from a string before it is logged or served. A configured RPC endpoint
 * commonly embeds an API key (Helius `?api-key=`, QuickNode/Alchemy in the URL path), and
 * transport errors include the endpoint URL verbatim; the agent serves its recent errors
 * publicly, so any URL is reduced to scheme + host and every api-key token is masked. Pure,
 * so it stays in core. sourceRef: .claude/REFERENCE_SECURITY_AUDIT.md (NEVER expose secrets).
 */

// A URL with optional userinfo, host, and any path/query: drop userinfo, path, and query (the
// query and path are where embedded keys live), keep scheme + host for debuggability.
const URL_WITH_PATH = /(https?:\/\/)(?:[^@/\s]+@)?([^/\s?#]+)[^\s]*/gi;
// A bare api-key / apikey / api_key token outside a URL.
const API_KEY_PARAM = /(api[-_]?key=)[^\s&"']+/gi;

/** Reduce every URL to scheme + host and mask every api-key token in the text. */
export const redactSecrets = (text: string): string =>
  text.replace(URL_WITH_PATH, '$1$2/[redacted]').replace(API_KEY_PARAM, '$1[redacted]');
