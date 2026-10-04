/**
 * Adding one MCP server entry to a TOML agent configuration, without touching
 * anything else in it.
 *
 * This is not a TOML parser and does not pretend to be one. It understands one
 * thing: a section header is a line that begins with `[` at the start of a line.
 * Everything else, including every value, is copied through as text. That is
 * enough to place or replace a single table without reformatting, reordering or
 * re-quoting anything the person who owns the file wrote.
 *
 * The limitation is real and is stated in the package README: a line that begins
 * with `[` inside a multi-line string is mistaken for a section header. No
 * supported agent's configuration file uses one.
 *
 * Status: **implemented and tested** in `packages/cli/test/config-toml.test.ts`.
 */

import type { McpServerEntry } from './config-json.js';

/** The table a Codex MCP server is filed under. */
export const CODEX_SERVERS_KEY = 'mcp_servers';

export type TomlMergeOutcome = 'created' | 'updated' | 'unchanged';

export type TomlMergeResult =
  | { readonly ok: true; readonly text: string; readonly outcome: TomlMergeOutcome }
  | { readonly ok: false; readonly error: string };

interface TomlSection {
  /** The name between the brackets, trimmed. */
  readonly name: string;
  /** The header line and every line up to the next header, exactly as written. */
  readonly raw: string;
}

interface TomlDocument {
  /** Everything before the first section header. */
  readonly preamble: string;
  readonly sections: readonly TomlSection[];
}

const HEADER = /^[[\]]*\s*\[([^\]\r\n]*)\][^\r\n]*$/;

function parseDocument(text: string): TomlDocument {
  const lines = text.split('\n');
  const preambleLines: string[] = [];
  const sections: TomlSection[] = [];
  let current: { name: string; lines: string[] } | undefined;

  for (const line of lines) {
    const header = HEADER.exec(line.trim());
    if (header?.[1] !== undefined) {
      if (current !== undefined) {
        sections.push({ name: current.name, raw: current.lines.join('\n') });
      }
      current = { name: header[1].trim(), lines: [line] };
      continue;
    }
    if (current === undefined) {
      preambleLines.push(line);
      continue;
    }
    current.lines.push(line);
  }

  if (current !== undefined) {
    sections.push({ name: current.name, raw: current.lines.join('\n') });
  }

  return { preamble: preambleLines.join('\n'), sections };
}

/** A TOML basic string, escaped. Used for every value this package writes. */
export function tomlString(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
  return `"${escaped}"`;
}

/** A TOML array of basic strings on one line. */
export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

export function renderEntryTable(tableName: string, entry: McpServerEntry): string {
  const lines = [`[${tableName}]`, `command = ${tomlString(entry.command)}`];
  if (entry.args.length > 0) {
    lines.push(`args = ${tomlStringArray(entry.args)}`);
  }
  if (entry.env !== undefined) {
    for (const [key, value] of Object.entries(entry.env)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Merges one entry into a TOML agent configuration.
 *
 * `existing` is undefined when the file does not exist. The whole file is owned
 * by this package only for the one table named by `tableName`; every other table
 * and the preamble are copied through byte for byte, so a second `mcp_servers`
 * entry and any unrelated setting survive.
 */
export function mergeTomlConfig(
  existing: string | undefined,
  entry: McpServerEntry,
  options: { readonly tableName: string },
): TomlMergeResult {
  const table = renderEntryTable(options.tableName, entry);

  if (existing === undefined || existing.trim() === '') {
    return { ok: true, text: `${table}\n`, outcome: 'created' };
  }

  const document = parseDocument(existing);
  const index = document.sections.findIndex((section) => section.name === options.tableName);

  const sections = [...document.sections];
  if (index === -1) {
    sections.push({ name: options.tableName, raw: table });
  } else {
    const found = document.sections[index];
    sections[index] = { name: found?.name ?? options.tableName, raw: table };
  }

  const preamble =
    document.preamble.trim() === '' ? '' : `${document.preamble.replace(/\s+$/, '')}\n\n`;
  const body = sections
    .map((section) => section.raw.replace(/\s+$/, ''))
    .filter((section) => section !== '')
    .join('\n\n');
  const text = `${preamble}${body}\n`;

  return { ok: true, text, outcome: text === existing ? 'unchanged' : 'updated' };
}
