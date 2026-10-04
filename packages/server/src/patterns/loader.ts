/**
 * Pattern pack loader and YAML schema validator.
 *
 * Status: **implemented and tested**.
 *
 * Core claims and invariants:
 * - A decision record that misdescribes itself is worse than no record.
 * - The safety check is advisory; it never prevents an agent from acting.
 * - Pack signatures are placeholders: a pack is reported as 'unsigned' and nothing
 *   may claim it is verified.
 * - On invalid packs, clear errors naming the file, the rule, and the line number
 *   are returned without throwing through the server.
 * - Bad packs are skipped and reported; the server still starts and serves valid packs.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import _Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { type Document, LineCounter, isMap, isPair, isScalar, isSeq, parseDocument } from 'yaml';
import type { DecisionType } from '../core/schema.js';
import type { DatabaseStore } from '../store/index.js';
import type { PatternEngine } from './engine.js';
import type { Rule, RuleMatchers, RuleOutput } from './types.js';

type AjvConstructor = new (options?: Record<string, unknown>) => {
  compile(schema: unknown): ValidateFunction;
};

const AjvClass: AjvConstructor = ((_Ajv as unknown as { default?: unknown }).default ??
  _Ajv) as AjvConstructor;

export interface PackSignaturePlaceholder {
  readonly status: 'unsigned';
  readonly algorithm?: string | undefined;
  readonly key_id?: string | undefined;
  readonly value?: string | undefined;
  readonly [key: string]: unknown;
}

export interface PackManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly source?: 'builtin' | 'community' | string | undefined;
  readonly signature?: PackSignaturePlaceholder | string | null | undefined;
}

export interface LoadedPack {
  readonly manifest: PackManifest;
  readonly rules: readonly Rule[];
  readonly filePath?: string | undefined;
  readonly signatureStatus: 'unsigned';
}

export interface PackValidationError {
  readonly filePath: string;
  readonly line: number;
  readonly column?: number | undefined;
  readonly ruleId?: string | undefined;
  readonly ruleIndex?: number | undefined;
  readonly property?: string | undefined;
  readonly message: string;
  readonly formatted: string;
}

export interface PackLoadSuccess {
  readonly ok: true;
  readonly pack: LoadedPack;
  readonly rules: readonly Rule[];
  readonly errors: readonly [];
}

export interface PackLoadFailure {
  readonly ok: false;
  readonly pack?: undefined;
  readonly rules: readonly [];
  readonly errors: readonly PackValidationError[];
}

export type PackLoadResult = PackLoadSuccess | PackLoadFailure;

export interface MultiPackLoadResult {
  readonly loadedPacks: readonly LoadedPack[];
  readonly rules: readonly Rule[];
  readonly errors: readonly PackValidationError[];
}

let cachedSchema: Record<string, unknown> | null = null;
let cachedValidator: ValidateFunction | null = null;

/**
 * Returns the resolved file path to the pattern pack JSON schema.
 */
export function getPackSchemaPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, '../../../../packages/packs/schema.json'),
    resolve(currentDir, '../../../packs/schema.json'),
    resolve(process.cwd(), 'packages/packs/schema.json'),
    resolve(process.cwd(), 'packs/schema.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

/**
 * Loads and returns the parsed pattern pack JSON schema.
 */
export function getPackSchema(): Record<string, unknown> {
  if (!cachedSchema) {
    const schemaPath = getPackSchemaPath();
    if (!existsSync(schemaPath)) {
      throw new Error(`Pattern pack schema file not found at: ${schemaPath}`);
    }
    const raw = readFileSync(schemaPath, 'utf8');
    cachedSchema = JSON.parse(raw) as Record<string, unknown>;
  }
  return cachedSchema;
}

/**
 * Creates and caches the Ajv validator for pattern packs.
 */
export function createPackValidator(): ValidateFunction {
  if (!cachedValidator) {
    const schema = getPackSchema();
    const ajv = new AjvClass({
      allErrors: true,
      allowUnionTypes: true,
      verbose: true,
    });
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator!;
}

interface ResolvedPosition {
  line: number;
  column: number;
  ruleId?: string | undefined;
  ruleIndex?: number | undefined;
  property?: string | undefined;
}

/**
 * Resolves the 1-based line number, column, rule ID and rule index in a YAML document
 * corresponding to an Ajv error instancePath and missing property.
 */
function resolvePositionFromDoc(
  doc: Document,
  lineCounter: LineCounter,
  instancePath: string,
  missingProperty?: string,
): ResolvedPosition {
  let line = 1;
  let column = 1;
  let ruleId: string | undefined;
  let ruleIndex: number | undefined;
  let property: string | undefined;

  const parts = instancePath.split('/').filter(Boolean);

  if (parts[0] === 'rules' && parts.length >= 2 && /^\d+$/.test(parts[1]!)) {
    ruleIndex = parseInt(parts[1]!, 10);
  }

  let current: unknown = doc.contents;
  let targetNode: unknown = doc.contents;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!current) break;

    // Check if we are traversing a rule map to grab the rule's ID
    if (i === 1 && ruleIndex !== undefined && isSeq(current)) {
      const item = current.items[ruleIndex];
      if (isMap(item)) {
        const idPair = item.items.find((p) => isScalar(p.key) && String(p.key.value) === 'id');
        if (idPair && isScalar(idPair.value) && idPair.value.value !== undefined) {
          ruleId = String(idPair.value.value);
        }
      }
    }

    if (isMap(current)) {
      const pair = current.items.find((p) => isScalar(p.key) && String(p.key.value) === part);
      if (pair) {
        targetNode = pair;
        current = pair.value;
      } else {
        break;
      }
    } else if (isSeq(current)) {
      const idx = parseInt(part, 10);
      if (!isNaN(idx) && current.items[idx]) {
        targetNode = current.items[idx];
        current = current.items[idx];
      } else {
        break;
      }
    } else if (isPair(current)) {
      current = current.value;
      i--;
    }
  }

  // If a property was missing from a mapping
  if (missingProperty) {
    property = missingProperty;
    if (isMap(current)) {
      targetNode = current;
    }
  } else if (parts.length > 0) {
    property = parts.slice(ruleIndex !== undefined ? 2 : 0).join('.');
  }

  // Fallback scan for ruleId if not yet resolved
  if (!ruleId && ruleIndex !== undefined && doc.contents && isMap(doc.contents)) {
    const rulesPair = doc.contents.items.find(
      (p) => isScalar(p.key) && String(p.key.value) === 'rules',
    );
    if (rulesPair && isSeq(rulesPair.value) && rulesPair.value.items[ruleIndex]) {
      const ruleItem = rulesPair.value.items[ruleIndex];
      if (isMap(ruleItem)) {
        const idPair = ruleItem.items.find((p) => isScalar(p.key) && String(p.key.value) === 'id');
        if (idPair && isScalar(idPair.value) && idPair.value.value !== undefined) {
          ruleId = String(idPair.value.value);
        }
      }
    }
  }

  const range = isPair(targetNode)
    ? ((targetNode.key as { range?: [number, number, number] })?.range ??
      (targetNode.value as { range?: [number, number, number] })?.range)
    : (targetNode as { range?: [number, number, number] })?.range;

  if (range && range.length > 0) {
    const pos = lineCounter.linePos(range[0]!);
    line = pos.line;
    column = pos.col;
  }

  return { line, column, ruleId, ruleIndex, property };
}

/**
 * Formats a PackValidationError into a clear human-readable string naming
 * the file, the rule (if applicable), and the line number.
 */
export function formatPackValidationError(error: PackValidationError): string {
  const fileLabel = basename(error.filePath) || error.filePath;
  if (error.ruleId) {
    const propPart = error.property ? `property "${error.property}" ` : '';
    return `[${fileLabel}:${error.line}] Rule "${error.ruleId}": ${propPart}${error.message}`;
  }
  if (error.ruleIndex !== undefined) {
    const propPart = error.property ? `property "${error.property}" ` : '';
    return `[${fileLabel}:${error.line}] Rule at index ${error.ruleIndex}: ${propPart}${error.message}`;
  }
  const propPart = error.property ? `property "${error.property}" ` : '';
  return `[${fileLabel}:${error.line}] Manifest: ${propPart}${error.message}`;
}

/**
 * Validates a parsed pack object against the pattern pack schema, using YAML AST
 * position info to report exact line numbers.
 */
export function validatePackObject(
  data: unknown,
  filePath: string,
  doc?: Document,
  lineCounter?: LineCounter,
): PackValidationError[] {
  const validator = createPackValidator();
  const valid = validator(data);
  if (valid) {
    return [];
  }

  const errors: PackValidationError[] = [];
  const ajvErrors = (validator.errors ?? []) as ErrorObject[];

  for (const err of ajvErrors) {
    const missingProp =
      err.keyword === 'required'
        ? (err.params as { missingProperty?: string }).missingProperty
        : undefined;

    let line = 1;
    let column = 1;
    let ruleId: string | undefined;
    let ruleIndex: number | undefined;
    let property: string | undefined = missingProp;

    if (doc && lineCounter) {
      const pos = resolvePositionFromDoc(doc, lineCounter, err.instancePath, missingProp);
      line = pos.line;
      column = pos.column;
      ruleId = pos.ruleId;
      ruleIndex = pos.ruleIndex;
      property = pos.property ?? missingProp;
    }

    const message = err.message ?? 'validation failed';
    const validationError: PackValidationError = {
      filePath,
      line,
      column,
      ruleId,
      ruleIndex,
      property,
      message,
      formatted: '',
    };

    const formatted = formatPackValidationError(validationError);
    errors.push({ ...validationError, formatted });
  }

  return errors;
}

/**
 * Converts a raw validated rule object from a pack into an engine typed Rule.
 */
function convertToEngineRule(rawRule: Record<string, unknown>, packId: string): Rule {
  const rawOutput = (rawRule.output ?? {}) as Record<string, unknown>;
  const decisionType = (rawOutput.type ?? rawOutput.decision_type) as DecisionType | undefined;

  const output: RuleOutput = {
    value: rawOutput.value as string | number | boolean,
    confidence: Number(rawOutput.confidence ?? 1.0),
    type: decisionType,
    decision_type: decisionType,
    distribution:
      rawOutput.distribution && typeof rawOutput.distribution === 'object'
        ? (rawOutput.distribution as Record<string, number>)
        : undefined,
  };

  const isSafety = Boolean(rawRule.safety ?? rawRule.is_safety);

  const rule: Rule = {
    id: String(rawRule.id),
    name: typeof rawRule.name === 'string' ? rawRule.name : undefined,
    description: typeof rawRule.description === 'string' ? rawRule.description : undefined,
    pack_id: typeof rawRule.pack_id === 'string' ? rawRule.pack_id : packId,
    safety: isSafety,
    is_safety: isSafety,
    matchers: (rawRule.matchers ?? {}) as RuleMatchers,
    output,
    specificity: typeof rawRule.specificity === 'number' ? rawRule.specificity : undefined,
  };

  return rule;
}

/**
 * Loads and validates a pattern pack from a YAML string.
 *
 * On error, returns a failure result with line-numbered errors without throwing.
 */
export function loadPackYaml(yamlContent: string, filePath = '<inline-yaml>'): PackLoadResult {
  const lineCounter = new LineCounter();
  let doc: Document;

  try {
    doc = parseDocument(yamlContent, { lineCounter });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const validationErr: PackValidationError = {
      filePath,
      line: 1,
      column: 1,
      message: `YAML parse error: ${errorMsg}`,
      formatted: `[${basename(filePath) || filePath}:1] YAML parse error: ${errorMsg}`,
    };
    return {
      ok: false,
      rules: [],
      errors: [validationErr],
    };
  }

  if (doc.errors && doc.errors.length > 0) {
    const errors: PackValidationError[] = doc.errors.map((err) => {
      const line = err.linePos?.[0]?.line ?? 1;
      const column = err.linePos?.[0]?.col ?? 1;
      return {
        filePath,
        line,
        column,
        message: `YAML syntax error: ${err.message}`,
        formatted: `[${basename(filePath) || filePath}:${line}] YAML syntax error: ${err.message}`,
      };
    });
    return {
      ok: false,
      rules: [],
      errors,
    };
  }

  const parsedData = doc.toJS();
  if (!parsedData || typeof parsedData !== 'object') {
    const emptyErr: PackValidationError = {
      filePath,
      line: 1,
      column: 1,
      message: 'Pack document is empty or not an object',
      formatted: `[${basename(filePath) || filePath}:1] Manifest: Pack document is empty or not an object`,
    };
    return {
      ok: false,
      rules: [],
      errors: [emptyErr],
    };
  }

  const validationErrors = validatePackObject(parsedData, filePath, doc, lineCounter);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      rules: [],
      errors: validationErrors,
    };
  }

  const rawManifest = parsedData as Record<string, unknown>;
  const packId = String(rawManifest.id);

  const manifest: PackManifest = {
    id: packId,
    name: String(rawManifest.name),
    version: String(rawManifest.version),
    description: typeof rawManifest.description === 'string' ? rawManifest.description : undefined,
    source: (typeof rawManifest.source === 'string' ? rawManifest.source : 'builtin') as
      'builtin' | 'community',
    signature: {
      status: 'unsigned',
      algorithm:
        typeof rawManifest.signature === 'object' && rawManifest.signature
          ? ((rawManifest.signature as Record<string, unknown>).algorithm as string | undefined)
          : undefined,
      key_id:
        typeof rawManifest.signature === 'object' && rawManifest.signature
          ? ((rawManifest.signature as Record<string, unknown>).key_id as string | undefined)
          : undefined,
      value:
        typeof rawManifest.signature === 'string'
          ? rawManifest.signature
          : typeof rawManifest.signature === 'object' && rawManifest.signature
            ? ((rawManifest.signature as Record<string, unknown>).value as string | undefined)
            : undefined,
    },
  };

  const rawRules = Array.isArray(rawManifest.rules)
    ? (rawManifest.rules as Record<string, unknown>[])
    : [];

  const rules: Rule[] = rawRules.map((r) => convertToEngineRule(r, packId));

  const loadedPack: LoadedPack = {
    manifest,
    rules,
    filePath,
    signatureStatus: 'unsigned',
  };

  return {
    ok: true,
    pack: loadedPack,
    rules,
    errors: [],
  };
}

/**
 * Loads and validates a pattern pack from a file on disk.
 *
 * On error, returns a failure result with line-numbered errors without throwing.
 */
export function loadPackFile(filePath: string): PackLoadResult {
  if (!existsSync(filePath)) {
    const error: PackValidationError = {
      filePath,
      line: 1,
      column: 1,
      message: `File not found: ${filePath}`,
      formatted: `[${basename(filePath) || filePath}:1] File not found: ${filePath}`,
    };
    return {
      ok: false,
      rules: [],
      errors: [error],
    };
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const error: PackValidationError = {
      filePath,
      line: 1,
      column: 1,
      message: `Failed to read file: ${errorMsg}`,
      formatted: `[${basename(filePath) || filePath}:1] Failed to read file: ${errorMsg}`,
    };
    return {
      ok: false,
      rules: [],
      errors: [error],
    };
  }

  return loadPackYaml(content, filePath);
}

/**
 * Loads multiple pack files. Valid packs are retained and invalid packs are skipped
 * and reported with line-numbered errors.
 */
export function loadPackFiles(filePaths: readonly string[]): MultiPackLoadResult {
  const loadedPacks: LoadedPack[] = [];
  const rules: Rule[] = [];
  const errors: PackValidationError[] = [];

  for (const filePath of filePaths) {
    const result = loadPackFile(filePath);
    if (result.ok) {
      loadedPacks.push(result.pack);
      rules.push(...result.rules);
    } else {
      errors.push(...result.errors);
    }
  }

  return { loadedPacks, rules, errors };
}

/**
 * Loads all YAML pattern packs from a directory.
 */
export function loadPacksFromDirectory(dirPath: string): MultiPackLoadResult {
  if (!existsSync(dirPath)) {
    const error: PackValidationError = {
      filePath: dirPath,
      line: 1,
      column: 1,
      message: `Directory not found: ${dirPath}`,
      formatted: `[${basename(dirPath) || dirPath}:1] Directory not found: ${dirPath}`,
    };
    return { loadedPacks: [], rules: [], errors: [error] };
  }

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const error: PackValidationError = {
      filePath: dirPath,
      line: 1,
      column: 1,
      message: `Failed to read directory: ${errorMsg}`,
      formatted: `[${basename(dirPath) || dirPath}:1] Failed to read directory: ${errorMsg}`,
    };
    return { loadedPacks: [], rules: [], errors: [error] };
  }

  const yamlFiles = entries
    .filter((entry) => {
      const ext = extname(entry).toLowerCase();
      return ext === '.yaml' || ext === '.yml';
    })
    .sort()
    .map((entry) => join(dirPath, entry));

  return loadPackFiles(yamlFiles);
}

/**
 * Loads packs from file paths or directories into an existing PatternEngine instance.
 * Bad packs are skipped and reported, and valid rules are added to the engine.
 */
export function loadPacksIntoEngine(
  engine: PatternEngine,
  filePathsOrDirs: readonly string[] | string,
): MultiPackLoadResult {
  const targets = Array.isArray(filePathsOrDirs) ? filePathsOrDirs : [filePathsOrDirs];
  const allLoadedPacks: LoadedPack[] = [];
  const allRules: Rule[] = [];
  const allErrors: PackValidationError[] = [];

  for (const target of targets) {
    if (!existsSync(target)) {
      allErrors.push({
        filePath: target,
        line: 1,
        column: 1,
        message: `Path not found: ${target}`,
        formatted: `[${basename(target) || target}:1] Path not found: ${target}`,
      });
      continue;
    }

    const stat = statSync(target);
    const result = stat.isDirectory() ? loadPacksFromDirectory(target) : loadPackFiles([target]);

    allLoadedPacks.push(...result.loadedPacks);
    allRules.push(...result.rules);
    allErrors.push(...result.errors);
  }

  if (allRules.length > 0) {
    engine.loadRules(allRules);
  }

  return {
    loadedPacks: allLoadedPacks,
    rules: allRules,
    errors: allErrors,
  };
}

/**
 * Loads active (promoted) learned patterns from the store into a PatternEngine instance.
 *
 * Invariants:
 * - A promoted pattern NEVER carries the safety flag and can never override a safety rule:
 *   safety and is_safety are forced to false / 0 on all loaded learned patterns.
 * - A learned pattern's output confidence is capped by its measured agreement:
 *   confidence = Math.min(rule.output.confidence, measured_agreement).
 */
export function loadActivePatternsIntoEngine(engine: PatternEngine, store: DatabaseStore): Rule[] {
  const activePatterns = store.patterns.list({ status: 'active' });
  const loadedRules: Rule[] = [];

  for (const pattern of activePatterns) {
    let rawRule: unknown;
    try {
      rawRule = JSON.parse(pattern.rules);
    } catch {
      continue;
    }

    if (!rawRule || typeof rawRule !== 'object') {
      continue;
    }

    const ruleObj = rawRule as Record<string, unknown>;
    const rawOutput = (ruleObj.output ?? {}) as Record<string, unknown>;
    const decisionType = (rawOutput.type ?? rawOutput.decision_type ?? pattern.decision_type) as
      DecisionType | undefined;

    let statedConfidence =
      typeof rawOutput.confidence === 'number' ? rawOutput.confidence : (pattern.confidence ?? 1.0);

    // Invariant: A learned pattern's own output confidence must be capped by its measured agreement
    const stats = store.patternStats.getById(pattern.id);
    if (stats && stats.sample_count > 0) {
      const agreement = stats.agreed_count / stats.sample_count;
      statedConfidence = Math.min(statedConfidence, agreement);
    }

    const output: RuleOutput = {
      value: rawOutput.value as string | number | boolean,
      confidence: Number(statedConfidence.toFixed(4)),
      type: decisionType,
      decision_type: decisionType,
      distribution:
        rawOutput.distribution && typeof rawOutput.distribution === 'object'
          ? (rawOutput.distribution as Record<string, number>)
          : undefined,
    };

    const rule: Rule = {
      id: pattern.id,
      name: pattern.name ?? (typeof ruleObj.name === 'string' ? ruleObj.name : undefined),
      description: typeof ruleObj.description === 'string' ? ruleObj.description : undefined,
      pack_id:
        pattern.pack_id ?? (typeof ruleObj.pack_id === 'string' ? ruleObj.pack_id : undefined),
      // Invariant: Promoted pattern NEVER carries safety flag
      safety: false,
      is_safety: false,
      status: 'active',
      matchers: (ruleObj.matchers ?? {}) as RuleMatchers,
      output,
      specificity: typeof ruleObj.specificity === 'number' ? ruleObj.specificity : undefined,
    };

    engine.addRule(rule);
    loadedRules.push(rule);
  }

  return loadedRules;
}
