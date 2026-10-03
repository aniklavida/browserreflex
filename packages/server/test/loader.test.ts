import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, type BrowserReflexMcpServer } from '../src/mcp/server.js';
import {
  type DatabaseStore,
  createStore,
  getPackSchema,
  getPackSchemaPath,
  loadPackFile,
  loadPacksFromDirectory,
  loadPacksIntoEngine,
  loadPackYaml,
  createPatternEngine,
} from '../src/index.js';

describe('pattern pack loader and schema validation', () => {
  let tempDir: string;
  let dbPath: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-loader-'));
    dbPath = join(tempDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('schema and manifest', () => {
    it('loads the pack schema file successfully', () => {
      const schemaPath = getPackSchemaPath();
      expect(schemaPath).toBeDefined();
      const schema = getPackSchema();
      expect(schema.$id).toBe('https://browserreflex.dev/schemas/pack.json');
      expect(schema.required).toContain('id');
      expect(schema.required).toContain('rules');
    });

    it('loads the example cookie banner pack and produces typed rules', () => {
      const examplePath = join(getPackSchemaPath(), '..', 'examples', 'cookie-banner.yaml');
      const result = loadPackFile(examplePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.pack.manifest.id).toBe('example-cookie-pack');
      expect(result.pack.manifest.name).toBe('Example Cookie Consent Pack');
      expect(result.pack.manifest.version).toBe('1.0.0');
      expect(result.pack.manifest.source).toBe('builtin');
      // Signature is a placeholder and must be reported as unsigned
      expect(result.pack.signatureStatus).toBe('unsigned');
      const sig = result.pack.manifest.signature;
      if (typeof sig === 'object' && sig !== null) {
        expect(sig.status).toBe('unsigned');
      }

      expect(result.rules.length).toBe(1);
      const rule = result.rules[0]!;
      expect(rule.id).toBe('example-cookie-dismiss');
      expect(rule.pack_id).toBe('example-cookie-pack');
      expect(rule.safety).toBe(false);
      expect(rule.output.value).toBe(true);
      expect(rule.output.confidence).toBe(0.95);
      expect(rule.output.type).toBe('check');
    });

    it('reports pack signature as unsigned placeholder even when signature field is present', () => {
      const yamlWithSig = `id: signed-sample
name: Signed Sample
version: 1.0.0
source: community
signature:
  status: unverified
  algorithm: ed25519
  key_id: key_123
  value: fake_signature_bytes
rules:
  - id: sample-rule
    matchers:
      text_any: test
    output:
      value: true
      confidence: 0.9
`;
      const result = loadPackYaml(yamlWithSig, 'signed-sample.yaml');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Status must strictly remain unsigned placeholder
      expect(result.pack.signatureStatus).toBe('unsigned');
      const sig = result.pack.manifest.signature;
      if (typeof sig === 'object' && sig !== null) {
        expect(sig.status).toBe('unsigned');
      }
    });
  });

  describe('error reporting with line numbers', () => {
    it('rejects an invalid pack rule with exact line number and rule ID', () => {
      const invalidYaml = `id: test-bad-pack
name: Bad Pack
version: 1.0.0
source: builtin
rules:
  - id: rule-valid
    matchers:
      text_any: accept
    output:
      value: true
      confidence: 0.9
  - id: rule-broken-confidence
    matchers:
      text_any: deny
    output:
      value: false
      confidence: 'not-a-number'
`;
      const filePath = join(tempDir, 'bad-confidence.yaml');
      writeFileSync(filePath, invalidYaml, 'utf8');

      const result = loadPackFile(filePath);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors.length).toBeGreaterThan(0);
      const err = result.errors.find((e) => e.ruleId === 'rule-broken-confidence');
      expect(err).toBeDefined();
      expect(err!.ruleId).toBe('rule-broken-confidence');
      expect(err!.filePath).toBe(filePath);
      // Line 17 is where confidence: 'not-a-number' is located
      expect(err!.line).toBe(17);
      expect(err!.formatted).toContain('bad-confidence.yaml');
      expect(err!.formatted).toContain('rule-broken-confidence');
      expect(err!.formatted).toContain('17');
    });

    it('rejects a rule missing required matchers with line number and rule ID', () => {
      const missingMatchersYaml = `id: test-missing-matchers
name: Missing Matchers Pack
version: 1.0.0
rules:
  - id: rule-without-matchers
    output:
      value: true
      confidence: 0.8
`;
      const filePath = join(tempDir, 'missing-matchers.yaml');
      writeFileSync(filePath, missingMatchersYaml, 'utf8');

      const result = loadPackFile(filePath);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors.length).toBeGreaterThan(0);
      const err = result.errors[0]!;
      expect(err.ruleId).toBe('rule-without-matchers');
      // Line 5 is where - id: rule-without-matchers begins
      expect(err.line).toBe(5);
      expect(err.message).toContain('matchers');
      expect(err.formatted).toContain('rule-without-matchers');
      expect(err.formatted).toContain('5');
    });

    it('rejects a rule missing an id with line number and rule index', () => {
      const missingIdYaml = `id: test-missing-id
name: Missing ID Pack
version: 1.0.0
rules:
  - name: nameless-rule
    matchers:
      role: button
    output:
      value: click
      confidence: 0.7
`;
      const filePath = join(tempDir, 'missing-id.yaml');
      writeFileSync(filePath, missingIdYaml, 'utf8');

      const result = loadPackFile(filePath);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const err = result.errors[0]!;
      expect(err.ruleIndex).toBe(0);
      expect(err.line).toBe(5);
      expect(err.message).toContain('id');
      expect(err.formatted).toContain('index 0');
      expect(err.formatted).toContain('5');
    });

    it('rejects invalid YAML syntax with exact line number', () => {
      const syntaxErrorYaml = `id: syntax-error-pack
name: Syntax Error
version: 1.0.0
rules:
  - id: rule-1
    matchers:
      text_any: [unclosed bracket
    output:
      value: true
      confidence: 1.0
`;
      const filePath = join(tempDir, 'syntax-error.yaml');
      writeFileSync(filePath, syntaxErrorYaml, 'utf8');

      const result = loadPackFile(filePath);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const err = result.errors[0]!;
      expect(err.line).toBeGreaterThanOrEqual(7);
      expect(err.message).toContain('YAML syntax error');
      expect(err.formatted).toContain('syntax-error.yaml');
    });

    it('rejects invalid manifest missing version with line number', () => {
      const missingVersionYaml = `id: no-version-pack
name: No Version Pack
rules: []
`;
      const filePath = join(tempDir, 'no-version.yaml');
      writeFileSync(filePath, missingVersionYaml, 'utf8');

      const result = loadPackFile(filePath);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const err = result.errors[0]!;
      expect(err.line).toBe(1);
      expect(err.message).toContain('version');
      expect(err.formatted).toContain('Manifest');
    });
  });

  describe('directory and multi-pack loading', () => {
    it('skips invalid packs and retains valid packs when loading directory', () => {
      const packsDir = join(tempDir, 'packs');
      mkdirSync(packsDir, { recursive: true });

      const validPack1 = `id: valid-pack-1
name: Valid Pack 1
version: 1.0.0
source: builtin
rules:
  - id: rule-p1
    matchers:
      text_any: hello
    output:
      value: world
      confidence: 0.9
`;

      const invalidPack = `id: bad-pack
name: Bad Pack
version: 1.0.0
rules:
  - id: bad-rule
    matchers:
      text_any: fail
    output:
      value: fail
      confidence: 2.5
`;

      const validPack2 = `id: valid-pack-2
name: Valid Pack 2
version: 1.0.0
rules:
  - id: rule-p2
    matchers:
      role: link
    output:
      value: clicked
      confidence: 0.85
`;

      writeFileSync(join(packsDir, '01-valid.yaml'), validPack1, 'utf8');
      writeFileSync(join(packsDir, '02-bad.yaml'), invalidPack, 'utf8');
      writeFileSync(join(packsDir, '03-valid.yaml'), validPack2, 'utf8');

      const multiResult = loadPacksFromDirectory(packsDir);
      expect(multiResult.loadedPacks.length).toBe(2);
      expect(multiResult.rules.length).toBe(2);
      expect(multiResult.errors.length).toBeGreaterThan(0);

      const badErr = multiResult.errors.find((e) => e.ruleId === 'bad-rule');
      expect(badErr).toBeDefined();
      expect(badErr!.line).toBe(10);

      const engine = createPatternEngine();
      loadPacksIntoEngine(engine, packsDir);
      expect(engine.size).toBe(2);
    });
  });

  describe('MCP server startup with valid and invalid packs', () => {
    it('proves invalid pack fails with a clear error and server still starts and serves valid pack', async () => {
      const validYaml = `id: valid-server-pack
name: Valid Server Pack
version: 1.0.0
source: builtin
rules:
  - id: cookie-accept-fastpath
    name: Auto accept cookies
    safety: false
    matchers:
      text_any: accept cookies
      role: button
    output:
      type: check
      value: true
      confidence: 0.98
`;

      const invalidYaml = `id: invalid-server-pack
name: Invalid Server Pack
version: 1.0.0
source: community
rules:
  - id: broken-rule-in-pack
    matchers:
      text_any: error trigger
    output:
      value: bad
      confidence: 'not-a-float'
`;

      const validPath = join(tempDir, 'valid-server-pack.yaml');
      const invalidPath = join(tempDir, 'invalid-server-pack.yaml');
      writeFileSync(validPath, validYaml, 'utf8');
      writeFileSync(invalidPath, invalidYaml, 'utf8');

      // Intercept stderr to verify warning output
      const stderrWrites: string[] = [];
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown) => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      let built: BrowserReflexMcpServer;
      try {
        built = await createMcpServer({
          store,
          packPaths: [validPath, invalidPath],
        });
      } finally {
        process.stderr.write = origStderrWrite;
      }

      // 1. The server still started
      expect(built).toBeDefined();
      expect(built.server).toBeDefined();
      expect(built.toolNames).toContain('decide');

      // 2. The invalid pack was rejected with line number and rule ID
      expect(built.packErrors.length).toBeGreaterThan(0);
      const badError = built.packErrors.find((e) => e.ruleId === 'broken-rule-in-pack');
      expect(badError).toBeDefined();
      expect(badError!.line).toBe(11);
      expect(badError!.filePath).toBe(invalidPath);
      expect(badError!.formatted).toContain('invalid-server-pack.yaml');
      expect(badError!.formatted).toContain('broken-rule-in-pack');
      expect(badError!.formatted).toContain('11');

      // 3. Stderr received diagnostic warning naming file and line number
      const stderrOutput = stderrWrites.join('');
      expect(stderrOutput).toContain('invalid-server-pack.yaml');
      expect(stderrOutput).toContain('11');

      // 4. The valid pack was successfully loaded into the server's pattern engine
      expect(built.loadedPacks.length).toBe(1);
      expect(built.loadedPacks[0]!.manifest.id).toBe('valid-server-pack');
      expect(built.patternEngine.size).toBe(1);

      // 5. Calling decide on the server matches the valid pack's rule
      const decideTool = await import('../src/tools/decide.js');
      const decideResult = await decideTool.executeDecide(
        {
          questions: [
            {
              id: 'q_cookie',
              type: 'check',
              text: 'Should the cookie banner be accepted?',
            },
          ],
          state: {
            elements: [
              {
                role: 'button',
                text: 'Please accept cookies to proceed',
              },
            ],
          },
        },
        {
          store,
          patternEngine: built.patternEngine,
        },
      );

      expect(decideResult.answers.length).toBe(1);
      const answer = decideResult.answers[0]!;
      expect(answer.path).toBe('pattern');
      expect(answer.pattern_id).toBe('cookie-accept-fastpath');
      expect(answer.value).toBe(true);
      expect(answer.confidence).toBe(0.98);
    });
  });
});
