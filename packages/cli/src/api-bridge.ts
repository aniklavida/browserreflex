/**
 * The two calls this package makes into the server package: start the local API,
 * and run the MCP server on stdio.
 *
 * Both are dynamic imports with a fallback from the built output to the
 * TypeScript sources. The built file is what a user of an installed package gets;
 * the source path is what a developer running from a checkout gets, before
 * anything has been compiled. If neither can be loaded the failure is reported as
 * text: this package never reports that a server it could not start is running.
 *
 * Status: **implemented and tested** in `packages/cli/test/api-bridge.test.ts`
 * for the resolution, the loopback address, the store it opens and the failure
 * when the port is taken. The MCP round trip itself is tested in
 * `packages/server/test/mcp-stdio.test.ts`.
 */

/** The handle `startApiServer` returns, narrowed to what this package uses. */
export interface ApiHandle {
  readonly port: number;
  readonly address: string;
  stop(): Promise<void>;
}

export interface StartApiOptions {
  readonly port?: number | undefined;
  readonly staticDir?: string | undefined;
}

/** A handle that also closes the database it opened. */
export interface OwnedApiHandle extends ApiHandle {
  stop(): Promise<void>;
}

/** The module shape expected from the server package's api entry. */
interface ApiModule {
  startApiServer(store: unknown, options: StartApiOptions): Promise<ApiHandle>;
}

/** The module shape expected from the server package's store entry. */
interface StoreModule {
  DatabaseStore: new (path?: string) => { close(): void };
}

/** The module shape expected from the server package's stdio entry. */
interface StartModule {
  main(): Promise<unknown>;
}

/**
 * The places the server package can be loaded from, in order.
 *
 * 1. The declared dependency, which is what an installed copy of this package
 *    resolves. `@browserreflex/server` declares no `exports` field, so the file
 *    path under it resolves directly.
 * 2. The workspace sibling, for a checkout where the dependency is a link.
 * 3. The TypeScript source, for a runner that compiles TypeScript on the fly.
 *
 * All three are tried before the call is reported as a failure, and the failure
 * message lists them, because "it did not work" is not something this package
 * may report without saying what it tried.
 */
function serverCandidates(folder: string, file: string): string[] {
  return [
    `@browserreflex/server/dist/${folder}/${file}`,
    `../../server/dist/${folder}/${file}`,
    `../../server/src/${folder}/${file}`,
  ];
}

async function importFirst<T>(candidates: readonly string[], what: string): Promise<T> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return (await import(candidate)) as T;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `the server package could not be loaded for ${what}. Tried:\n${failures.join('\n')}`,
  );
}

/** Opens the SQLite store the server package uses. */
export async function openStore(databasePath: string): Promise<{ close(): void }> {
  const module = await importFirst<StoreModule>(
    serverCandidates('store', 'index.js'),
    'the decision store',
  );
  return new module.DatabaseStore(databasePath);
}

/** Starts the local REST API. It binds to loopback inside the server package. */
export async function startLocalApi(
  store: unknown,
  options: StartApiOptions = {},
): Promise<ApiHandle> {
  const module = await importFirst<ApiModule>(serverCandidates('api', 'index.js'), 'the local API');
  return module.startApiServer(store, options);
}

/**
 * Opens the database and starts the local API, returning a handle whose `stop`
 * closes both, in that order.
 *
 * This is what `init` calls: the wizard page reads the store, so the database has
 * to exist before the browser is sent there.
 */
export async function startApiForDatabase(
  databasePath: string,
  options: StartApiOptions = {},
): Promise<OwnedApiHandle> {
  const store = await openStore(databasePath);
  try {
    const api = await startLocalApi(store, options);
    return {
      port: api.port,
      address: api.address,
      stop: async (): Promise<void> => {
        await api.stop();
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

/** Runs the MCP server on stdio, which is what an agent configuration points at. */
export async function startMcpStdio(): Promise<unknown> {
  const module = await importFirst<StartModule>(
    serverCandidates('mcp', 'start.js'),
    'the MCP stdio server',
  );
  return module.main();
}
