import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The `packages/server` directory. */
export const serverPackageRoot = resolve(here, '../..');

/** The server entry as TypeScript source, run through tsx in the tests. */
export const sourceEntry = resolve(serverPackageRoot, 'src/mcp/start.ts');

/** The server entry as compiled by `pnpm build`, which is what the tests measure. */
export const builtEntry = resolve(serverPackageRoot, 'dist/mcp/start.js');

function spawnParameters(entry: string) {
  const tempDbDir = mkdtempSync(join(tmpdir(), 'browserreflex-stdio-test-'));
  return {
    command: process.execPath,
    args: entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry],
    cwd: serverPackageRoot,
    env: {
      ...process.env,
      BROWSERREFLEX_DB_PATH: process.env.BROWSERREFLEX_DB_PATH ?? join(tempDbDir, 'test.db'),
    },
    stderr: 'pipe' as const,
  };
}

export interface ConnectedServer {
  readonly client: Client;
  /** Everything the server wrote to stderr, which is where diagnostics belong. */
  readonly serverStderr: () => string;
}

/** Starts the server as a child process and completes the MCP handshake with it. */
export async function connectToServer(entry: string): Promise<ConnectedServer> {
  const transport = new StdioClientTransport(spawnParameters(entry));
  const chunks: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  const client = new Client({ name: 'browserreflex-test-client', version: '0.0.0' });
  await client.connect(transport);

  return { client, serverStderr: () => Buffer.concat(chunks).toString('utf8') };
}

/**
 * Milliseconds from spawning the server to a completed `initialize` handshake.
 *
 * This is the measurement behind the "starts in under a second" claim: it includes
 * process start, module loading and the handshake round trip.
 */
export async function measureStartupMs(entry: string): Promise<number> {
  const startedAt = process.hrtime.bigint();
  const { client } = await connectToServer(entry);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  await client.close();
  return elapsedMs;
}

/**
 * Returns the compiled entry, building the package first when it is missing.
 *
 * CI runs `pnpm build` before `pnpm test`, so this normally only checks that the file
 * exists. A build failure here fails the test with that output rather than quietly
 * measuring nothing.
 */
export function ensureBuiltEntry(): string {
  if (!existsSync(builtEntry)) {
    const require = createRequire(import.meta.url);
    const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', resolve(serverPackageRoot, 'tsconfig.json')], {
      cwd: serverPackageRoot,
      stdio: 'inherit',
    });
  }
  if (!existsSync(builtEntry)) {
    throw new Error(
      `The compiled server entry ${builtEntry} is missing after a build, so no startup time was measured.`,
    );
  }
  return builtEntry;
}

/** Reads a JSON file relative to this helper. */
export function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
