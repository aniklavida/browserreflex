#!/usr/bin/env node

/**
 * Checks that the three representations of BrowserReflex instructions:
 * 1. packages/skill/SKILL.md (for Claude, with frontmatter)
 * 2. packages/skill/AGENTS.md (snippet for Codex and AGENTS.md readers)
 * 3. packages/server MCP instructions string
 *
 * carry identical shared instruction bodies and do not drift apart.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');

/**
 * Extracts YAML frontmatter and markdown body from SKILL.md.
 */
export function parseSkillFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n+([\s\S]*)$/);
  if (!match) {
    throw new Error(`${filePath} is missing valid YAML frontmatter (---)`);
  }
  const frontmatterRaw = match[1];
  const body = match[2].trim();

  const nameMatch = frontmatterRaw.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatterRaw.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !nameMatch[1]?.trim()) {
    throw new Error(`${filePath} frontmatter is missing 'name'`);
  }
  if (!descMatch || !descMatch[1]?.trim()) {
    throw new Error(`${filePath} frontmatter is missing 'description'`);
  }

  return {
    name: nameMatch[1].trim(),
    description: descMatch[1].trim(),
    body,
  };
}

/**
 * Normalizes newlines to \n and trims trailing whitespace.
 */
export function normalizeText(text) {
  return text.replace(/\r\n/g, '\n').trim();
}

/** The TypeScript module that embeds the shared body, so the compiled server needs no file. */
export const GENERATED_BODY_PATH = 'packages/server/src/mcp/skill/body.generated.ts';

/** The source of the generated module for a given shared body. */
export function generatedModuleSource(body) {
  const escaped = normalizeText(body)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  return (
    '// Generated from packages/skill/SKILL.md by scripts/check-skill-drift.mjs --sync.\n' +
    '// Do not edit by hand: edit SKILL.md and run `pnpm run check-skill -- --sync`.\n' +
    `export const SHARED_INSTRUCTIONS_BODY = \`${escaped}\n\`;\n`
  );
}

/**
 * Checks for drift between SKILL.md body and AGENTS.md.
 */
export function checkSkillDrift(options = {}) {
  const root = options.repoRoot || repoRoot;
  const skillPath = resolve(root, 'packages/skill/SKILL.md');
  const agentsPath = resolve(root, 'packages/skill/AGENTS.md');

  const { name, description, body: rawSkillBody } = parseSkillFile(skillPath);

  if (!existsSync(agentsPath)) {
    return {
      ok: false,
      error: `AGENTS.md not found at ${agentsPath}`,
    };
  }

  const rawAgents = readFileSync(agentsPath, 'utf8');
  const skillBody = normalizeText(rawSkillBody);
  const agentsBody = normalizeText(rawAgents);

  if (skillBody !== agentsBody) {
    return {
      ok: false,
      error:
        'Drift detected: packages/skill/AGENTS.md does not match packages/skill/SKILL.md shared body.',
      skillBody,
      agentsBody,
    };
  }

  const generatedPath = resolve(root, GENERATED_BODY_PATH);
  if (!existsSync(generatedPath)) {
    return { ok: false, error: `${GENERATED_BODY_PATH} not found. Run the sync.` };
  }
  if (readFileSync(generatedPath, 'utf8') !== generatedModuleSource(skillBody)) {
    return {
      ok: false,
      error: `Drift detected: ${GENERATED_BODY_PATH} does not match packages/skill/SKILL.md. Run the sync.`,
    };
  }

  return {
    ok: true,
    name,
    description,
    body: skillBody,
  };
}

/**
 * Synchronizes AGENTS.md from the SKILL.md shared body.
 */
export function syncSkillFiles(options = {}) {
  const root = options.repoRoot || repoRoot;
  const skillPath = resolve(root, 'packages/skill/SKILL.md');
  const agentsPath = resolve(root, 'packages/skill/AGENTS.md');

  const { body } = parseSkillFile(skillPath);
  const normalized = normalizeText(body);
  writeFileSync(agentsPath, `${normalized}\n`, 'utf8');
  writeFileSync(resolve(root, GENERATED_BODY_PATH), generatedModuleSource(normalized), 'utf8');
}

// CLI runner
if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  const shouldSync = args.includes('--sync') || args.includes('--write');

  if (shouldSync) {
    syncSkillFiles();
    console.log('Synchronized AGENTS.md and the embedded server body from packages/skill/SKILL.md');
  }

  const result = checkSkillDrift();
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  } else {
    console.log(
      'Skill files verified: SKILL.md, AGENTS.md and the embedded server body carry identical shared bodies.',
    );
  }
}
