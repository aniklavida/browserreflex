import { loadInstructions } from './instructions.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defaultToolsDirectory, loadToolDefinitions } from './tools/registry.js';
import type { ToolContext } from './tools/tool.js';
import { createStore, type DatabaseStore } from '../store/index.js';
import { createSessionTracker, logDecision, type SessionTracker } from '../core/log.js';
import type { DecisionPath, Question, Answer } from '../core/schema.js';

/** Server name sent in the MCP handshake. */
export const SERVER_NAME = 'browserreflex';

/**
 * Version sent in the MCP handshake. Kept equal to the package version; a test reads
 * `package.json` and fails if the two drift apart.
 */
export const SERVER_VERSION = '0.1.0';

/** Transport label reported to tools. The initial release ships the stdio transport only. */
export const SERVER_TRANSPORT = 'stdio';

export interface CreateServerOptions {
  readonly name?: string;
  readonly version?: string;
  /** Label passed to tools in their context. */
  readonly transport?: string;
  /** Directory scanned for `*.tool.ts` / `*.tool.js` files. */
  readonly toolsDirectory?: URL;
  /** Overrides the served instruction text. Intended for tests. */
  readonly instructions?: string;
  /** Store instance for sessions and decisions. */
  readonly store?: DatabaseStore;
  /** Custom database path if store is not provided. */
  readonly dbPath?: string;
}

export interface BrowserReflexMcpServer {
  readonly server: McpServer;
  /** Names of the registered tools, in registration order. */
  readonly toolNames: readonly string[];
  /** The text served as the `instructions` field. */
  readonly instructions: string;
  /** Database store used by the server. */
  readonly store: DatabaseStore;
  /** Session tracker for MCP connections. */
  readonly sessionTracker: SessionTracker;
}

/**
 * Builds the MCP server: handshake identity, the `instructions` field and every tool
 * found in the tools directory.
 *
 * A malformed tool file fails here, so the server either serves the tools it was built
 * with or it does not start.
 */
export async function createMcpServer(
  options: CreateServerOptions = {},
): Promise<BrowserReflexMcpServer> {
  const name = options.name ?? SERVER_NAME;
  const version = options.version ?? SERVER_VERSION;
  const transport = options.transport ?? SERVER_TRANSPORT;
  const instructions = options.instructions ?? loadInstructions();
  const definitions = await loadToolDefinitions(options.toolsDirectory ?? defaultToolsDirectory());
  const store = options.store ?? createStore(options.dbPath);
  const sessionTracker = createSessionTracker(store);

  const toolNames = definitions.map((definition) => definition.name);
  const baseContext: ToolContext = {
    serverName: name,
    serverVersion: version,
    transport,
    toolNames,
    store,
  };

  const server = new McpServer({ name, version }, { instructions });

  // Hook connection initialization to detect sessions per MCP connection
  const underlyingServer = server.server;
  const internalServer = underlyingServer as unknown as {
    _oninitialize: (request: {
      params?: {
        clientInfo?: { name?: string; version?: string };
        protocolVersion?: string;
        capabilities?: unknown;
      };
    }) => Promise<unknown>;
    onclose?: () => void;
  };

  const origOnInitialize = internalServer._oninitialize.bind(underlyingServer);
  internalServer._oninitialize = async (request) => {
    const result = await origOnInitialize(request);
    const clientInfo = request.params?.clientInfo;
    const agentName =
      typeof clientInfo?.name === 'string' && clientInfo.name.trim().length > 0
        ? clientInfo.name.trim()
        : 'unknown';

    sessionTracker.createConnectionSession(agentName, {
      clientInfo: clientInfo ?? null,
      protocolVersion: request.params?.protocolVersion ?? null,
      capabilities: request.params?.capabilities ?? null,
      transport,
    });
    return result;
  };

  // Hook connection closure to update session status
  const origOnClose = internalServer.onclose?.bind(underlyingServer);
  internalServer.onclose = () => {
    sessionTracker.closeActiveSession();
    origOnClose?.();
  };

  const origClose = server.close.bind(server);
  server.close = async () => {
    sessionTracker.closeActiveSession();
    return origClose();
  };

  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
      },
      async (args) => {
        const activeSession = sessionTracker.getActiveSession();
        const callContext: ToolContext = {
          ...baseContext,
          session: activeSession ?? undefined,
          sessionId: activeSession?.id ?? undefined,
          logDecision: (params) =>
            logDecision({
              session: activeSession,
              store,
              ...params,
            }),
        };

        const startTime = performance.now();
        const result = await definition.handle(args as Record<string, unknown>, callContext);
        const elapsedMs = Math.round(performance.now() - startTime);

        // Ensure every question answered in this tool call produces exactly one decisions row
        if (result && typeof result === 'object' && result.structuredContent) {
          const structured = result.structuredContent as Record<string, unknown>;
          if (Array.isArray(structured.answers)) {
            const rawQuestions = Array.isArray(args.questions) ? (args.questions as unknown[]) : [];
            for (let i = 0; i < structured.answers.length; i++) {
              const ans = structured.answers[i] as Record<string, unknown>;
              if (ans && typeof ans === 'object' && !ans.decision_id && !ans.decisionId) {
                const q = rawQuestions[i] ?? `question_${i + 1}`;
                const logged = logDecision({
                  question: q as string | Question,
                  answer: ans as unknown as Answer,
                  path: (ans.path as DecisionPath) ?? 'check',
                  confidence: typeof ans.confidence === 'number' ? ans.confidence : 1.0,
                  latencyMs:
                    typeof ans.latencyMs === 'number'
                      ? ans.latencyMs
                      : typeof ans.latency_ms === 'number'
                        ? ans.latency_ms
                        : elapsedMs,
                  session: activeSession,
                  store,
                  url: typeof args.url === 'string' ? args.url : undefined,
                });
                ans.decision_id = logged.id;
                ans.decisionId = logged.id;
              }
            }
          } else if (structured.answer && typeof structured.answer === 'object') {
            const ans = structured.answer as Record<string, unknown>;
            if (!ans.decision_id && !ans.decisionId) {
              const q = (args.question as unknown) ?? 'question';
              const logged = logDecision({
                question: q as string | Question,
                answer: ans as unknown as Answer,
                path: (ans.path as DecisionPath) ?? 'check',
                confidence: typeof ans.confidence === 'number' ? ans.confidence : 1.0,
                latencyMs:
                  typeof ans.latencyMs === 'number'
                    ? ans.latencyMs
                    : typeof ans.latency_ms === 'number'
                      ? ans.latency_ms
                      : elapsedMs,
                session: activeSession,
                store,
                url: typeof args.url === 'string' ? args.url : undefined,
              });
              ans.decision_id = logged.id;
              ans.decisionId = logged.id;
            }
          }
        }

        return result;
      },
    );
  }

  return { server, toolNames, instructions, store, sessionTracker };
}
