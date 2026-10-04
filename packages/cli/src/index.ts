/**
 * Public surface of the BrowserReflex CLI package.
 *
 * The package is never published: it exists so `npx browserreflex-mcp init` and the
 * `serve` entry an agent configuration points at run from one place.
 *
 * Status: **implemented and tested** in `packages/cli/test/`.
 */

export {
  AGENT_IDS,
  AGENT_DEFINITIONS,
  SERVER_ENTRY_NAME,
  configPathOverrideVariable,
  findAgent,
  isAgentId,
  resolveAgentConfigPath,
  type AgentDefinition,
  type AgentId,
  type AgentPathContext,
  type ConfigFormat,
  type ConfigStatus,
  type ResolvedAgentPath,
} from './agents.js';
export {
  DEFAULT_SERVER_COMMAND,
  SERVE_ARGUMENT,
  parseArgs,
  splitCommandLine,
  usageText,
  type Command,
  type ParsedArgs,
} from './args.js';
export {
  MCP_SERVERS_KEY,
  detectIndent,
  mergeJsonConfig,
  serializeEntry,
  serializeJson,
  type JsonMergeResult,
  type McpServerEntry,
  type MergeOutcome,
} from './config-json.js';
export {
  CODEX_SERVERS_KEY,
  mergeTomlConfig,
  renderEntryTable,
  tomlString,
  tomlStringArray,
  type TomlMergeResult,
} from './config-toml.js';
export { backupPathFor, writeConfigFile } from './config-write.js';
export {
  openUrl,
  openUrlCommand,
  type OpenUrlCommand,
  type OpenUrlOptions,
  type OpenUrlResult,
} from './open-url.js';
export {
  SUPPORTED_PLATFORMS,
  currentPlatform,
  joinFor,
  pathFor,
  resolveHome,
  type HomeContext,
  type HomeResolution,
  type HomeSource,
  type Platform,
} from './paths.js';
export {
  DATABASE_FILE_NAME,
  DATA_DIRECTORY_NAME,
  DEFAULT_INIT_PORT,
  SETUP_WIZARD_ROUTE,
  applyAgentConfig,
  buildServerEntry,
  exitCodeFor,
  renderReport,
  resolveDatabasePath,
  runInit,
  selectAgents,
  type AgentResult,
  type AgentWriteStatus,
  type ApiStatus,
  type InitFileSystem,
  type InitOptions,
  type InitReport,
  type OpenStatus,
} from './init.js';
export {
  FAILURE_EXIT_CODE,
  USAGE_ERROR_EXIT_CODE,
  USAGE_EXIT_CODE,
  agentSummaryLines,
  findStaticUiDir,
  packageVersion,
  runCli,
  type CliEnvironment,
  type CliStreams,
} from './cli.js';
export {
  openStore,
  startApiForDatabase,
  startLocalApi,
  startMcpStdio,
  type ApiHandle,
  type OwnedApiHandle,
  type StartApiOptions,
} from './api-bridge.js';
export {
  generateReport,
  renderReportText,
  runReport,
  type DailyFastPath,
  type MeasurementReport,
  type ReportOptions,
} from './report.js';
