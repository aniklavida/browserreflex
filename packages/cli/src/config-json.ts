/**
 * Adding one MCP server entry to a JSON agent configuration, without touching
 * anything else in it.
 *
 * Three rules, and each of them exists because breaking it loses someone's
 * configuration:
 *
 * 1. The file is parsed first. A file that does not parse is refused, not
 *    replaced. Writing a default document over a broken one would destroy the
 *    only copy of whatever the person had in it.
 * 2. Only the `mcpServers` object is read and written. Every other key in the
 *    document is copied through untouched, including keys this package has never
 *    heard of.
 * 3. If the merged document is byte-identical to the file on disk, nothing is
 *    written and no backup is made. That is what makes a second run a no-op.
 *
 * Status: **implemented and tested** in `packages/cli/test/config-json.test.ts`.
 */

/** An MCP server entry as written into an agent configuration. */
export interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** The key every supported agent files MCP servers under. */
export const MCP_SERVERS_KEY = 'mcpServers';

export type MergeOutcome = 'created' | 'updated' | 'unchanged';

export type JsonMergeResult =
  | { readonly ok: true; readonly text: string; readonly outcome: MergeOutcome }
  | { readonly ok: false; readonly error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Serializes an entry in the shape the JSON formats use: `env` omitted when empty. */
export function serializeEntry(entry: McpServerEntry): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    command: entry.command,
    args: [...entry.args],
  };
  if (entry.env !== undefined && Object.keys(entry.env).length > 0) {
    serialized['env'] = { ...entry.env };
  }
  return serialized;
}

/**
 * The indentation of an existing document, so a rewrite keeps the file's shape.
 *
 * Two spaces when there is nothing to copy from. Only a run of spaces is
 * accepted: a tab or an odd width is a sign the file was written by something
 * else, and guessing there would reformat the whole document.
 */
export function detectIndent(existing: string | undefined): string {
  if (existing === undefined) {
    return '  ';
  }
  for (const line of existing.split('\n')) {
    const match = /^([ ]+)\S/.exec(line);
    if (match?.[1] !== undefined) {
      return match[1].length <= 8 ? match[1] : '  ';
    }
  }
  return '  ';
}

export function serializeJson(value: unknown, indent: string): string {
  return `${JSON.stringify(value, null, indent)}\n`;
}

/**
 * Merges one entry into an agent's JSON configuration.
 *
 * `existing` is undefined when the file does not exist. The returned `text` is
 * the whole file as it would be on disk, which is what `--dry-run` prints.
 */
export function mergeJsonConfig(
  existing: string | undefined,
  entry: McpServerEntry,
  options: { readonly entryName: string; readonly indent?: string },
): JsonMergeResult {
  const indent = options.indent ?? detectIndent(existing);

  if (existing === undefined || existing.trim() === '') {
    const created: Record<string, unknown> = { [MCP_SERVERS_KEY]: {} };
    (created[MCP_SERVERS_KEY] as Record<string, unknown>)[options.entryName] =
      serializeEntry(entry);
    return { ok: true, text: serializeJson(created, indent), outcome: 'created' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    return {
      ok: false,
      error: `the file is not valid JSON (${error instanceof Error ? error.message : String(error)}), so it was left alone`,
    };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'the file does not hold a JSON object, so it was left alone' };
  }

  const existingServers = parsed[MCP_SERVERS_KEY];
  if (existingServers === undefined) {
    parsed[MCP_SERVERS_KEY] = { [options.entryName]: serializeEntry(entry) };
    return { ok: true, text: serializeJson(parsed, indent), outcome: 'updated' };
  }

  if (!isPlainObject(existingServers)) {
    return {
      ok: false,
      error: `the "${MCP_SERVERS_KEY}" key does not hold an object, so it was left alone`,
    };
  }

  const servers: Record<string, unknown> = existingServers;
  servers[options.entryName] = serializeEntry(entry);
  const text = serializeJson(parsed, indent);
  return { ok: true, text, outcome: text === existing ? 'unchanged' : 'updated' };
}
