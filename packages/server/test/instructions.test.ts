import { describe, expect, it } from 'vitest';
import { ADVISORY_MARKER, INSTRUCTIONS_SOURCE, loadInstructions } from '../src/mcp/instructions.js';
import { SKILL_TEXT } from '../src/mcp/skill/index.js';

describe('server instructions', () => {
  it('serves the shipped text, trimmed', () => {
    expect(loadInstructions()).toBe(SKILL_TEXT.trim());
  });

  it('serves text that says the safety check is advisory', () => {
    expect(loadInstructions().toLowerCase()).toContain(ADVISORY_MARKER);
  });

  it('refuses to serve text that does not say the safety check is advisory', () => {
    expect(() => loadInstructions('Stop the agent before it clicks.')).toThrow(INSTRUCTIONS_SOURCE);
  });

  it('refuses to serve empty text', () => {
    expect(() => loadInstructions('   \n  ')).toThrow(/is empty/);
  });

  it('names the tools this build serves and does not promise the planned ones', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toContain('server_status');
    expect(text).toContain('decide');
    expect(text).toMatch(/planned and are not implemented/);
    expect(text).toMatch(/never prevents an agent from acting/);
  });
});
