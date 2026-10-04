/**
 * Localhost guard for the local REST API.
 *
 * A request is served only when both of these hold:
 *
 * 1. the remote address is a loopback address, and
 * 2. the Host header names a loopback host.
 *
 * The second check is what resists DNS rebinding. A name that resolves to
 * 127.0.0.1 is still refused, because the guard reads the header the browser
 * sent rather than looking anything up: a page on a name the attacker controls
 * points the browser at 127.0.0.1, and the Host header carries that name.
 *
 * The Host header is required. HTTP/1.1 asks every client to send it, and the
 * Node and browser clients this API serves (fetch, XHR, the CLI, curl) all send
 * it. A request without one is refused rather than trusted.
 *
 * The Origin check is separate and fails closed: with no configured origin
 * allowed, a request that carries an Origin header is refused. Only a request
 * with no Origin at all, which is a non-browser client, passes that check.
 *
 * Status: **implemented and tested** in `packages/server/test/api.test.ts`.
 * What this guard does not do: it does not stop an agent from calling the MCP
 * server. It only decides who may read the local data over HTTP.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Strips an IPv4-mapped IPv6 prefix (`::ffff:`) from a remote address. */
function unmappedAddress(addr: string): string {
  let plain = addr;
  if (plain.startsWith('::ffff:')) {
    plain = plain.slice('::ffff:'.length);
  }
  // A scope id such as `fe80::1%lo0` is not loopback and is left as it is.
  const percent = plain.indexOf('%');
  if (percent !== -1) {
    plain = plain.slice(0, percent);
  }
  return plain;
}

/**
 * True when a remote address is on the loopback interface.
 *
 * The whole 127.0.0.0/8 range counts, because all of it is loopback, and both
 * `::1` and an IPv4-mapped loopback address count.
 */
export function isLocalAddress(addr: string | undefined): boolean {
  if (typeof addr !== 'string' || addr === '') return false;
  const plain = unmappedAddress(addr);
  if (plain === '::1') return true;
  return (
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(plain) &&
    plain.split('.').every((part) => Number(part) <= 255)
  );
}

/** Strips a port from a Host header value and returns the host name part. */
function hostName(host: string): string {
  const trimmed = host.trim();
  // An IPv6 literal: `[::1]:4040` → `[::1]`
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close === -1 ? trimmed : trimmed.slice(0, close + 1);
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon === -1) return trimmed;
  // A bare IPv6 literal without brackets, such as `::1`, has several colons.
  if (trimmed.indexOf(':') !== colon) return trimmed;
  return trimmed.slice(0, colon);
}

/** True when a Host header names localhost or a loopback literal. */
export function isLocalHostName(host: string | undefined): boolean {
  if (typeof host !== 'string' || host === '') return false;
  const name = hostName(host).toLowerCase();
  if (name === 'localhost') return true;
  if (name === '[::1]' || name === '::1') return true;
  return isLocalAddress(name);
}

/**
 * True when the request may be served: a loopback remote address and a Host
 * header that names a loopback host. When it returns false the caller must send
 * a 403 and must not run a handler.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  if (!isLocalAddress(req.socket?.remoteAddress)) return false;
  return isLocalHostName(req.headers.host);
}

/**
 * True when a browser request from `allowedOrigins` is acceptable.
 *
 * A request with no Origin header is not a cross-origin browser request and is
 * allowed, because the same-origin browser calls and command line clients do not
 * send one. A request with an Origin header is allowed only when that origin is
 * in `allowedOrigins`. An empty list therefore refuses every request that
 * carries an Origin: the safe direction to fail in.
 */
export function isCorsAllowed(
  req: IncomingMessage,
  allowedOrigins: readonly string[] = [],
): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return allowedOrigins.includes(origin);
}

/** Sends a 403 Forbidden with a plain-text body and ends the response. */
export function rejectForbidden(res: ServerResponse, reason: string): void {
  res.writeHead(403, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(reason);
}
