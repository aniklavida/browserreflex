/**
 * The local REST API server.
 *
 * Bound to 127.0.0.1 and to nothing else. There is no option to widen that: the
 * bind address is a constant here, so a caller cannot turn it into a listener
 * another machine can reach.
 *
 * Every request passes two checks before a handler can run, in this order:
 *
 * 1. **Localhost guard.** The remote address must be loopback and the Host header
 *    must name a loopback host. The Host check is what resists DNS rebinding.
 * 2. **Origin check.** A request carrying an Origin header must name an allowed
 *    local origin. The default set is this server's own origin on its own port,
 *    which is where the same process serves the UI.
 *
 * A request that fails either check gets a 403 and no handler runs.
 *
 * The same process serves the built UI: pass `staticDir` and every non-API path
 * is answered from that directory. Nothing here is wired into the MCP start-up
 * yet; `startApiServer` is a separate call the later CLI makes.
 *
 * Status: **implemented and tested** in `packages/server/test/api.test.ts`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseStore } from '../store/index.js';
import { isCorsAllowed, isLocalRequest, rejectForbidden } from './guard.js';
import { ApiRouter } from './router.js';
import { errorResponse, HttpError } from './http.js';
import { registerExtraRoutes, type ApiDeps } from './extra.js';
import { createStaticUiHandler } from './static-ui.js';
import {
  handleGetStats,
  handleListDecisions,
  handleGetDecision,
  handleListReviews,
  handleAnswerReview,
  handleBulkReviews,
  handleGetSettings,
  handlePutSettings,
  handleGetPacks,
  handleGetPatterns,
} from './handlers.js';

/** The only address this server binds to. Not configurable on purpose. */
export const API_BIND_HOST = '127.0.0.1';

/** Default port. Port 0 asks the operating system for a free one. */
export const DEFAULT_API_PORT = 4040;

export interface ApiServerOptions extends ApiDeps {
  /** Port to listen on. Defaults to 4040; 0 asks the operating system. */
  readonly port?: number;
  /**
   * Origin allowed to make browser requests to the API, replacing the default of
   * this server's own origin on its own port. Useful when the UI runs on a
   * separate development port.
   */
  readonly uiOrigin?: string;
  /** Directory holding the built UI. Omit it and no page is served. */
  readonly staticDir?: string;
}

export interface ApiServerHandle {
  /** The underlying Node http.Server. */
  readonly server: Server;
  /** The port actually bound. */
  readonly port: number;
  /** The address the API and the UI are reachable at. */
  readonly address: string;
  /** The origins a browser request may carry. */
  readonly allowedOrigins: readonly string[];
  /** Stops the server and waits for it to close. */
  stop(): Promise<void>;
}

/** Builds the router for the store. Exported so a test can reach a route directly. */
export function createApiRouter(store: DatabaseStore, deps: ApiDeps = {}): ApiRouter {
  const router = new ApiRouter();
  router.get('/api/stats', handleGetStats(store));
  router.get('/api/decisions', handleListDecisions(store));
  router.get('/api/decisions/:id', handleGetDecision(store));
  router.get('/api/reviews', handleListReviews(store));
  // `/api/reviews/bulk` is registered before the parameterised answer route so a
  // literal segment can never be read as an id.
  router.post('/api/reviews/bulk', handleBulkReviews(store));
  router.post('/api/reviews/:id/answer', handleAnswerReview(store));
  router.get('/api/settings', handleGetSettings(store));
  router.put('/api/settings', handlePutSettings(store));
  router.get('/api/packs', handleGetPacks(store));
  router.get('/api/patterns', handleGetPatterns(store));
  registerExtraRoutes(router, store, deps);
  return router;
}

export interface RequestListenerOptions {
  readonly store: DatabaseStore;
  readonly allowedOrigins: readonly string[];
  readonly staticDir?: string | undefined;
  readonly deps?: ApiDeps | undefined;
}

/**
 * Builds the request handler.
 *
 * Exported so the guard, the dispatch and the static handler can be exercised
 * without a socket, and so the refusal path is testable on its own.
 */
export function createRequestListener(options: RequestListenerOptions) {
  const router = createApiRouter(options.store, options.deps ?? {});
  const staticUi =
    options.staticDir === undefined
      ? undefined
      : createStaticUiHandler({ root: options.staticDir });

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLocalRequest(req)) {
      rejectForbidden(res, 'Forbidden: only local connections with a local Host header are served');
      return;
    }

    if (!isCorsAllowed(req, options.allowedOrigins)) {
      rejectForbidden(res, 'Forbidden: cross-origin request rejected');
      return;
    }

    try {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      if (!pathname.startsWith('/api/') && pathname !== '/api' && staticUi !== undefined) {
        await staticUi(req, res);
        return;
      }

      const handled = await router.handle(req, res);
      if (!handled) {
        errorResponse(res, 404, 'Not found');
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        errorResponse(res, err.status, err.message);
        return;
      }
      // An unexpected failure says nothing to the client beyond the status: the
      // detail goes to stderr, which the operator can read and a browser cannot.
      process.stderr.write(`browserreflex api: request failed: ${String(err)}\n`);
      errorResponse(res, 500, 'Internal server error');
    }
  };
}

/** The origins allowed by default: this server's own origin on its own port. */
export function defaultAllowedOrigins(port: number): string[] {
  return [`http://${API_BIND_HOST}:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

/**
 * Starts the local REST API and returns a handle with `stop()`.
 *
 * The server binds to 127.0.0.1 only. Nothing calls this yet: the later CLI will
 * start it in the same process as the MCP server.
 */
export async function startApiServer(
  store: DatabaseStore,
  options: ApiServerOptions = {},
): Promise<ApiServerHandle> {
  const port = options.port ?? DEFAULT_API_PORT;

  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, API_BIND_HOST, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const bound = server.address();
  const boundPort = typeof bound === 'object' && bound !== null ? bound.port : port;
  const allowedOrigins =
    options.uiOrigin === undefined ? defaultAllowedOrigins(boundPort) : [options.uiOrigin];

  // The handler is attached after the port is known, so no request can be served
  // before the allowed origins are computed.
  server.on(
    'request',
    createRequestListener({
      store,
      allowedOrigins,
      staticDir: options.staticDir,
      deps: {
        keyStore: options.keyStore,
        keyTester: options.keyTester,
        home: options.home,
        streamPollMs: options.streamPollMs,
      },
    }),
  );

  return {
    server,
    port: boundPort,
    address: `http://${API_BIND_HOST}:${boundPort}`,
    allowedOrigins,
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections();
      });
    },
  };
}
