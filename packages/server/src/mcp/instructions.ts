import { SHARED_INSTRUCTIONS_BODY } from './skill/body.generated.js';

/** Where the served instruction text comes from, for logs and for the PR record. */
export const INSTRUCTIONS_SOURCE = 'packages/skill/SKILL.md';

/**
 * The word the served instruction text must contain.
 *
 * AGENTS.md requires every document that mentions the safety check to say that it is
 * advisory, and the `instructions` field is read by an agent rather than by a human.
 * Serving text that calls the check a block would be a false claim with an audience, so
 * text without this word is refused instead of served.
 */
export const ADVISORY_MARKER = 'advisory';

/**
 * Strips YAML frontmatter from raw markdown content if present.
 */
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
}

/**
 * Returns the shared instructions body.
 *
 * The body is embedded in `skill/body.generated.ts`, generated from `packages/skill/SKILL.md`
 * by `scripts/check-skill-drift.mjs --sync`, so the compiled server carries it and needs no
 * file at run time. A drift check fails when the embedded copy and SKILL.md differ.
 */
export function readSharedInstructionsBody(): string {
  return SHARED_INSTRUCTIONS_BODY.trim();
}

/**
 * Returns the text served as the MCP `instructions` field.
 *
 * `text` is a parameter so the guard below can be tested; production callers pass
 * nothing and get the shipped text from the single source of truth.
 */
export function loadInstructions(text?: string): string {
  const content = text ?? readSharedInstructionsBody();
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error(`The instruction text at ${INSTRUCTIONS_SOURCE} is empty.`);
  }
  if (!trimmed.toLowerCase().includes(ADVISORY_MARKER)) {
    throw new Error(
      `The instruction text at ${INSTRUCTIONS_SOURCE} does not say the safety check is ` +
        `${ADVISORY_MARKER}; it will not be served.`,
    );
  }
  return trimmed;
}
