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
    expect(text).toContain('submit_answers');
    expect(text).toContain('action_guard');
    expect(text).toMatch(/planned and are not implemented/);
    expect(text).toMatch(/never prevents an agent from acting/);
  });

  it('does not tell the agent to call a tool this build does not serve', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toContain('page_check');
    expect(text).toMatch(/`page_check`\. Do not plan a task around it/);
    expect(text).not.toMatch(/`action_guard` are planned/);
  });

  it('says what action_guard does and does not do, in the text an agent reads', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toMatch(/action_guard.*advisory/);
    expect(text).toMatch(/payment or destructive action always comes back `ask_user`/);
    expect(text).toMatch(/never read as an instruction/);
    expect(text).toMatch(/an agent that does not call it is not stopped by it/);
  });
});
