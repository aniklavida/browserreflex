/**
 * Minimal HTTP router for the local REST API.
 *
 * Routes are matched by method and by a path pattern. A pattern may contain
 * named segments prefixed with `:` (for example `/api/decisions/:id`), whose
 * values are passed to the handler as `params`. Routes are matched in the order
 * they were registered, so a literal segment registered before a parameter
 * segment wins.
 *
 * The router knows nothing about the localhost guard: that runs before dispatch,
 * in `createRequestListener`.
 *
 * Status: **implemented and tested**
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteParams {
  [key: string]: string;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: RouteParams,
) => Promise<void> | void;

interface Route {
  readonly method: string;
  readonly pattern: ReadonlyArray<string | { param: string }>;
  readonly handler: RouteHandler;
}

function compilePattern(path: string): ReadonlyArray<string | { param: string }> {
  // Strip the leading slash then split; that avoids an empty first segment.
  const normalised = path.startsWith('/') ? path.slice(1) : path;
  return normalised.split('/').map((seg) => (seg.startsWith(':') ? { param: seg.slice(1) } : seg));
}

function matchPath(
  pattern: ReadonlyArray<string | { param: string }>,
  segments: string[],
): RouteParams | null {
  if (pattern.length !== segments.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const part = pattern[i];
    if (typeof part === 'string') {
      if (part !== segments[i]) return null;
    } else {
      params[part.param] = decodeURIComponent(segments[i] ?? '');
    }
  }
  return params;
}

export class ApiRouter {
  private readonly routes: Route[] = [];

  on(method: string, path: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), pattern: compilePattern(path), handler });
    return this;
  }

  get(path: string, handler: RouteHandler): this {
    return this.on('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.on('POST', path, handler);
  }

  put(path: string, handler: RouteHandler): this {
    return this.on('PUT', path, handler);
  }

  /** Runs the first route that matches. Returns false when none does. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    const segments = rawPath.split('/').slice(1);
    const method = (req.method ?? 'GET').toUpperCase();

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.pattern, segments);
      if (params !== null) {
        await route.handler(req, res, params);
        return true;
      }
    }
    return false;
  }
}
