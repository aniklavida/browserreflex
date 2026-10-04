import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADVISORY_MARKER,
  INSTRUCTIONS_SOURCE,
  readSharedInstructionsBody,
  loadInstructions,
  stripFrontmatter,
} from '../src/mcp/instructions.js';
import { SKILL_TEXT } from '../src/mcp/skill/index.js';
import {
  checkSkillDrift,
  normalizeText,
  parseSkillFile,
} from '../../../scripts/check-skill-drift.mjs';

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
    expect(text).toContain('page_check');
    expect(text).toContain('submit_answers');
    expect(text).toContain('action_guard');
    expect(text).toContain('feedback');
    expect(text).toContain('get_pending_reviews');
    expect(text).toContain('get_stats');
    expect(text).toMatch(/every tool in the specification is served/i);
    expect(text).toMatch(/never prevents an agent from acting/);
    expect(text).not.toMatch(/page_check[^.]*planned/);
  });

  it('says that page content is data and is never read as an instruction', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toMatch(/never read as an instruction/);
  });

  it('does not tell the agent to call a tool this build does not serve', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toContain('page_check');
    expect(text).toMatch(/does not exist here, so do not plan a task around one/);
    expect(text).not.toMatch(/action_guard[^.]*is planned/);
  });

  it('says what action_guard does and does not do, in the text an agent reads', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toMatch(/action_guard.*advisory/);
    expect(text).toMatch(/payment or destructive action always comes back `ask_user`/);
    expect(text).toMatch(/never read as an instruction/);
    expect(text).toMatch(/an agent that does not call it is not stopped by it/);
  });

  it('provides question-writing rules in the instruction body', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toMatch(/typed questions/i);
    expect(text).toContain('choice');
    expect(text).toContain('check');
    expect(text).toContain('score');
    expect(text).toContain('text');
    expect(text).toMatch(/stable ids/i);
    expect(text).toMatch(/small option sets/i);
    expect(text).toMatch(/put page facts in context not in the question/i);
  });

  it('instructs how to handle needs_ai and needs_human', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toContain('needs_ai');
    expect(text).toMatch(/submit_answers.*decision_id/);
    expect(text).toContain('needs_human');
    expect(text).toMatch(/ask the user directly in conversation/);
  });

  it('explains how to read confidence and paths', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toMatch(/reading confidence/i);
    expect(text).toMatch(/confidence.*0\.0 and 1\.0/);
    expect(text).toContain('memory');
    expect(text).toContain('pattern');
    expect(text).toContain('check');
    expect(text).toContain('ai');
    expect(text).toContain('human');
  });

  it('tells the agent when to call action_guard and how to treat ask_user', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toMatch(/action_guard.*before a click, submit, delete, payment, send or publish/);
    expect(text).toMatch(/treat `ask_user` as a request to ask the person/i);
  });

  it('states when to send feedback', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toMatch(/when to send feedback/i);
    expect(text).toMatch(/feedback.*decision_id.*value/);
  });

  it('notes honestly that agent adherence is not measured', () => {
    const text = loadInstructions().replace(/\s+/g, ' ');

    expect(text).toMatch(/agent adherence is not measured/i);
    expect(text).toMatch(/Gate 1 check pending/i);
  });
});

describe('instruction drift and multi-target verification', () => {
  // The repository root, found from this file so the tests do not depend on the cwd.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const skillMdPath = resolve(root, 'packages/skill/SKILL.md');
  const agentsMdPath = resolve(root, 'packages/skill/AGENTS.md');

  it('embeds the SKILL.md body, so the served text needs no file at run time', () => {
    expect(existsSync(skillMdPath)).toBe(true);
    expect(readSharedInstructionsBody()).toBe(
      normalizeText(stripFrontmatter(readFileSync(skillMdPath, 'utf8'))),
    );
  });

  it('has valid YAML frontmatter in SKILL.md with name and description', () => {
    const { name, description, body } = parseSkillFile(skillMdPath);

    expect(name).toBe('browserreflex');
    expect(description).toBeTruthy();
    expect(description.length).toBeGreaterThan(10);
    expect(body).toContain('# BrowserReflex');
  });

  it('ensures packages/skill/AGENTS.md matches SKILL.md shared body byte-for-byte', () => {
    const skillContent = readFileSync(skillMdPath, 'utf8');
    const agentsContent = readFileSync(agentsMdPath, 'utf8');

    const expectedBody = normalizeText(stripFrontmatter(skillContent));
    const actualAgents = normalizeText(agentsContent);

    expect(actualAgents).toBe(expectedBody);
  });

  it('ensures MCP instructions string matches SKILL.md shared body byte-for-byte', () => {
    const skillContent = readFileSync(skillMdPath, 'utf8');
    const expectedBody = normalizeText(stripFrontmatter(skillContent));
    const servedInstructions = normalizeText(loadInstructions());

    expect(servedInstructions).toBe(expectedBody);
    expect(normalizeText(SKILL_TEXT)).toBe(expectedBody);
  });

  it('confirms checkSkillDrift succeeds on the shipped files', () => {
    const result = checkSkillDrift();
    expect(result.ok).toBe(true);
  });

  it('detects drift when AGENTS.md content is altered', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-drift-'));
    try {
      const skillDir = join(tempDir, 'packages/skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: browserreflex\ndescription: Test skill description.\n---\n\n# Body Alpha\n',
      );
      writeFileSync(join(skillDir, 'AGENTS.md'), '# Body Beta\n');

      const result = checkSkillDrift({ repoRoot: tempDir });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Drift detected/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses skill files with missing or invalid frontmatter', () => {
    expect(() => parseSkillFile(agentsMdPath)).toThrow(/missing valid YAML frontmatter/);
  });
});
