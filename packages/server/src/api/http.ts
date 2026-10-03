/**
 * JSON helpers for the REST API: reading request bodies and writing responses.
 *
 * Status: **implemented and tested**
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Largest request body the API accepts. Bigger than any payload here needs to be. */
export const MAX_BODY_BYTES = 512 * 1024;

/** An error that carries the status code the client should receive. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * The status a caught error should produce. Only an `HttpError` chooses one;
 * anything else is treated as a bad request rather than reported verbatim, so
 * that an internal message never reaches the client.
 */
export function errorStatus(err: unknown, fallback = 400): number {
  return err instanceof HttpError ? err.status : fallback;
}

/** A fixed message for a body that could not be read. Never echoes internals. */
export const UNREADABLE_BODY = 'Could not read request body';

/**
 * Reads and parses a JSON request body.
 *
 * Rejects with a 413 `HttpError` past `MAX_BODY_BYTES`, and with a 400 one when
 * the body is not JSON. An empty body resolves to `undefined`, so a handler can
 * tell "no body" from "bad body".
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (err: HttpError): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Stop collecting but keep the socket readable, so the 413 still reaches
        // the client instead of the connection being torn down mid-upload.
        fail(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        settled = true;
        resolve(undefined);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        settled = true;
        resolve(parsed);
      } catch {
        fail(new HttpError(400, 'Request body must be JSON'));
      }
    });

    req.on('error', () => {
      fail(new HttpError(400, UNREADABLE_BODY));
    });
  });
}

/** Writes a JSON response with the given status code. */
export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** Sends a structured error response. */
export function errorResponse(res: ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message });
}

/** Parses a query string into a record. */
export function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const qs = url.slice(idx + 1);
  const result: Record<string, string> = {};
  for (const pair of qs.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
    const val = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    result[key] = val;
  }
  return result;
}

/** Reads a positive integer query value, clamped to `min`..`max`, or returns undefined. */
export function intParam(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Reads a boolean query value written as `true` or `false`. */
export function boolParam(raw: string | undefined): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}
