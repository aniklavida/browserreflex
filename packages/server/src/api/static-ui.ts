/**
 * Serving the built local UI from the same process as the API.
 *
 * The UI is a single-page app: a request for a path with no file extension is an
 * app route, and the app's own `index.html` answers it so the client-side router
 * can take over. Anything with an extension is a file or an asset, and a missing
 * one is a 404 rather than a page.
 *
 * What exists today: the serving. The UI itself does not. `packages/ui` is an
 * empty placeholder package, so there is no build to point this at yet. When the
 * directory holds no `index.html` the response says exactly that instead of
 * pretending a page is there.
 *
 * A path may not leave the configured directory. The resolved path is compared
 * against the root, and anything above it is refused with a 403 before a file is
 * opened, so `..` segments and encoded ones cannot reach the rest of the disk.
 *
 * Status: **implemented and tested** in `packages/server/test/api.test.ts`
 * against a directory the test builds itself.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorResponse } from './http.js';

/** Content types for the file kinds a built front end ships. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const INDEX_FILE = 'index.html';

/** A front-end route: no extension, so the client's router owns it. */
function isAppRoute(pathname: string): boolean {
  return extname(pathname) === '';
}

/**
 * Turns a request path into an absolute path inside `root`, or null when the
 * request tries to leave it.
 *
 * The comparison is on the resolved path, so `..` and its encoded form are
 * handled by the same check rather than by pattern matching.
 */
export function resolveWithinRoot(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    return null;
  }
  return candidate;
}

async function statFile(path: string): Promise<{ size: number } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { size: info.size };
  } catch {
    return null;
  }
}

function sendFile(req: IncomingMessage, res: ServerResponse, path: string, size: number): void {
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'X-Content-Type-Options': 'nosniff',
    // A local tool: the built assets change under the user's feet, so nothing here is cached.
    'Cache-Control': 'no-store',
  });
  if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
}

export interface StaticUiOptions {
  /** The directory holding the built UI. Its `index.html` answers every app route. */
  readonly root: string;
}

/**
 * Builds the handler for every non-API path.
 *
 * Returns true when it answered the request. Callers then know not to look for
 * an API route.
 */
export function createStaticUiHandler(options: StaticUiOptions) {
  const root = resolve(options.root);

  return async function handleStaticUi(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      errorResponse(res, 405, `Method ${method} is not allowed for the local UI`);
      return true;
    }

    const url = req.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';
    const target = resolveWithinRoot(root, pathname);
    if (target === null) {
      errorResponse(res, 403, 'Path is outside the local UI directory');
      return true;
    }

    const indexPath = join(root, INDEX_FILE);
    const index = await statFile(indexPath);
    if (index === null) {
      errorResponse(
        res,
        404,
        'No local UI build is served by this process. The UI package is a placeholder and nothing is built yet.',
      );
      return true;
    }

    const file = await statFile(target);
    if (file !== null) {
      sendFile(req, res, target, file.size);
      return true;
    }

    // A client-side route with no extension is answered by the app shell.
    if (isAppRoute(pathname)) {
      sendFile(req, res, indexPath, index.size);
      return true;
    }

    errorResponse(res, 404, 'Not found');
    return true;
  };
}
