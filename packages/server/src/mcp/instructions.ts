import { SKILL_TEXT } from './skill/index.js';

/** Where the served instruction text comes from, for logs and for the PR record. */
export const INSTRUCTIONS_SOURCE = 'mcp/skill placeholder text';

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
 * Returns the text served as the MCP `instructions` field.
 *
 * `text` is a parameter so the guard below can be tested; production callers pass
 * nothing and get the shipped text.
 */
export function loadInstructions(text: string = SKILL_TEXT): string {
  const trimmed = text.trim();
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
