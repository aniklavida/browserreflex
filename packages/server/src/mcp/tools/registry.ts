import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ZodRawShape } from 'zod';
import type { ToolDefinition } from './tool.js';
import { TOOL_EXPORT_NAME, TOOL_NAME_PATTERN } from './tool.js';

/**
 * Discovers tool files by directory listing, so adding a tool is one new file and no
 * edit to a list somewhere else.
 *
 * Two suffixes are accepted because the same directory holds TypeScript sources while
 * the tests run and JavaScript once `tsc` has built the package. `.d.ts` and `.map`
 * files never match, so declaration output cannot register a phantom tool.
 */
const TOOL_FILE_SUFFIXES = ['.tool.ts', '.tool.js'] as const;

/** The tools directory that ships with this module: the directory this file sits in. */
export function defaultToolsDirectory(): URL {
  return new URL('./', import.meta.url);
}

/** Returns the sorted file names of every tool module in `directory`. */
export async function discoverToolFiles(
  directory: URL = defaultToolsDirectory(),
): Promise<string[]> {
  const entries = await readdir(directory);
  return entries
    .filter((entry) => TOOL_FILE_SUFFIXES.some((suffix) => entry.endsWith(suffix)))
    .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A zod schema of either supported major version exposes `parse`. */
function isZodType(value: unknown): boolean {
  return isRecord(value) && typeof value['parse'] === 'function';
}

/** A raw shape is a plain object whose every value is a zod schema. */
function isZodRawShape(value: unknown): value is ZodRawShape {
  return isRecord(value) && Object.values(value).every(isZodType);
}

/**
 * Checks one loaded tool module and returns the definition.
 *
 * A malformed file is an error, never a skipped file: a server that quietly serves one
 * tool less than it was built with is a server whose own description is wrong.
 */
export function readToolDefinition(fileName: string, module: unknown): ToolDefinition {
  if (!isRecord(module)) {
    throw new Error(`Tool file ${fileName} did not export an object module.`);
  }

  const candidate = module[TOOL_EXPORT_NAME];
  if (candidate === undefined) {
    throw new Error(`Tool file ${fileName} does not export a \`${TOOL_EXPORT_NAME}\` definition.`);
  }
  if (!isRecord(candidate)) {
    throw new Error(
      `Tool file ${fileName} exports a \`${TOOL_EXPORT_NAME}\` that is not an object.`,
    );
  }

  const { name, title, description, inputSchema, outputSchema, handle } = candidate;

  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Tool file ${fileName} declares the name ${JSON.stringify(name)}; a tool name must match ${TOOL_NAME_PATTERN}.`,
    );
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error(`Tool ${name} in ${fileName} needs a non-empty title.`);
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(`Tool ${name} in ${fileName} needs a non-empty description.`);
  }
  if (!isZodRawShape(inputSchema)) {
    throw new Error(
      `Tool ${name} in ${fileName} needs an inputSchema of zod schemas; use {} for no arguments.`,
    );
  }
  if (!isZodRawShape(outputSchema)) {
    throw new Error(`Tool ${name} in ${fileName} needs an outputSchema of zod schemas.`);
  }
  if (typeof handle !== 'function') {
    throw new Error(`Tool ${name} in ${fileName} needs a handle function.`);
  }

  return {
    name,
    title,
    description,
    inputSchema,
    outputSchema,
    handle: handle as ToolDefinition['handle'],
  };
}

/**
 * Loads every tool in `directory`, in file-name order, and rejects duplicate tool names.
 */
export async function loadToolDefinitions(
  directory: URL = defaultToolsDirectory(),
): Promise<ToolDefinition[]> {
  const directoryPath = fileURLToPath(directory);
  const fileNames = await discoverToolFiles(directory);
  if (fileNames.length === 0) {
    throw new Error(`No tool files (*.tool.ts or *.tool.js) were found in ${directoryPath}.`);
  }

  const definitions: ToolDefinition[] = [];
  const seen = new Map<string, string>();

  for (const fileName of fileNames) {
    const moduleUrl = pathToFileURL(join(directoryPath, fileName));
    const module: unknown = await import(moduleUrl.href);
    const definition = readToolDefinition(fileName, module);

    const previousFile = seen.get(definition.name);
    if (previousFile !== undefined) {
      throw new Error(
        `Tool name ${definition.name} is declared twice: ${previousFile} and ${fileName}.`,
      );
    }
    seen.set(definition.name, fileName);
    definitions.push(definition);
  }

  return definitions;
}
