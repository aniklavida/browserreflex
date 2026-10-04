/**
 * The agent instruction text served as the MCP server's `instructions` field.
 *
 * Status: **implemented and tested**.
 *
 * This module exports the instructions string loaded from the shared skill
 * source of truth (`packages/skill/SKILL.md`), ensuring that `SKILL.md`,
 * `AGENTS.md`, and the MCP instructions field never drift apart.
 */
import { loadInstructions } from '../instructions.js';

export const SKILL_TEXT = loadInstructions();
