import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { DatabaseStore } from '../src/store/index.js';
import { log, logDecision, setDefaultStore } from '../src/core/log.js';
import { hashForMemoryLookup } from '../src/security/redact.js';
import { type ChoiceQuestion, SchemaViolationException } from '../src/core/schema.js';
import { isSafetyAdvisory } from '../src/index.js';

function token(prefix: string, body: string): string {
  return `${prefix}${body}`;
}

const decisionToolDir = new URL('./fixtures/decision-tool/', import.meta.url);

describe('decision logging', () => {
  let store: DatabaseStore;

  beforeEach(() => {
    store = new DatabaseStore(':memory:');
    setDefaultStore(store);
  });

  afterEach(() => {
    setDefaultStore(null);
    store.close();
  });

  it('session detection creates exactly one sessions row per MCP connection', async () => {
    const built = await createMcpServer({
      store,
      toolsDirectory: decisionToolDir,
    });

    const initialSessions = store.sessions.list();
    expect(initialSessions).toHaveLength(0);

    // First client connects
    const [clientTransport1, serverTransport1] = InMemoryTransport.createLinkedPair();
    const client1 = new Client({ name: 'browser-agent-alpha', version: '1.0.0' });

    await built.server.connect(serverTransport1);
    await client1.connect(clientTransport1);

    const afterClient1 = store.sessions.list();
    expect(afterClient1).toHaveLength(1);
    expect(afterClient1[0]?.agent_name).toBe('browser-agent-alpha');
    expect(afterClient1[0]?.status).toBe('active');

    const trackerSession = built.sessionTracker.getActiveSession();
    expect(trackerSession).not.toBeNull();
    expect(trackerSession?.id).toBe(afterClient1[0]?.id);

    // Client 1 closes connection
    await client1.close();

    const afterClient1Close = store.sessions.list();
    expect(afterClient1Close).toHaveLength(1);
    const closedSession = store.sessions.getById(afterClient1[0]!.id);
    expect(closedSession?.status).toBe('completed');
  });

  it('every tool call produces exactly one decisions row per question', async () => {
    const built = await createMcpServer({
      store,
      toolsDirectory: decisionToolDir,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'browser-automation-worker', version: '2.1.0' });

    await built.server.connect(serverTransport);
    await client.connect(clientTransport);

    const activeSession = built.sessionTracker.getActiveSession();
    expect(activeSession).not.toBeNull();

    // 1. Tool call with 1 question -> produces exactly 1 decisions row
    const singleQuestionCall = await client.callTool({
      name: 'decision_probe',
      arguments: {
        questions: ['Is the submit button visible and interactable?'],
      },
    });

    expect(singleQuestionCall.isError).toBeFalsy();
    const decisionsAfterOne = store.decisions.list();
    expect(decisionsAfterOne).toHaveLength(1);
    expect(decisionsAfterOne[0]?.session_id).toBe(activeSession!.id);
    expect(decisionsAfterOne[0]?.question).toBe('Is the submit button visible and interactable?');
    expect(decisionsAfterOne[0]?.path).toBe('check');
    expect(decisionsAfterOne[0]?.confidence).toBe(0.95);
    expect(decisionsAfterOne[0]?.latency_ms).toBe(3);

    // 2. Tool call with 3 questions -> produces exactly 3 decisions rows (total 4)
    const multiQuestionCall = await client.callTool({
      name: 'decision_probe',
      arguments: {
        questions: [
          'What popup category matches this dialog?',
          'What is the risk score of the navigation target?',
          'Is this modal blocking page access?',
        ],
      },
    });

    expect(multiQuestionCall.isError).toBeFalsy();
    const decisionsAfterFour = store.decisions.list();
    expect(decisionsAfterFour).toHaveLength(4);

    // Verify all 4 decisions belong to the connection's session
    for (const d of decisionsAfterFour) {
      expect(d.session_id).toBe(activeSession!.id);
      expect(d.path).toBe('check');
      expect(d.confidence).toBe(0.95);
    }

    // 3. Tool call with 0 questions -> produces exactly 0 decisions rows (total remains 4)
    const zeroQuestionCall = await client.callTool({
      name: 'decision_probe',
      arguments: {
        questions: [],
      },
    });

    expect(zeroQuestionCall.isError).toBeFalsy();
    const decisionsAfterZero = store.decisions.list();
    expect(decisionsAfterZero).toHaveLength(4);

    await client.close();
  });

  it('the stored input is redacted', () => {
    const rawApiKey = token('s' + 'k-', 'test_secret_key_abcdef123456');
    const rawPassword = 's' + 'ecret_pwd_99!';
    const rawEmail = 'agent_tester@domain.com';

    const questionText = `Verify credentials for ${rawEmail} using ${rawApiKey}`;
    const contextInput = JSON.stringify({
      username: rawEmail,
      password: rawPassword,
      api_token: rawApiKey,
    });

    const expectedInputHash = hashForMemoryLookup(contextInput);

    const testSession = store.sessions.create({
      agent_name: 'redaction-test-agent',
    });

    const logged = logDecision({
      question: questionText,
      input: contextInput,
      answer: { allow: true },
      path: 'check',
      confidence: 0.99,
      latencyMs: 8,
      session: testSession.id,
      store,
    });

    const stored = store.decisions.getById(logged.id);
    expect(stored).not.toBeNull();

    // Verify stored input is redacted: secrets must NOT appear in the record
    expect(stored?.question).not.toContain(rawApiKey);
    expect(stored?.question).not.toContain(rawEmail);
    expect(stored?.context).not.toContain(rawApiKey);
    expect(stored?.context).not.toContain(rawPassword);
    expect(stored?.context).not.toContain(rawEmail);

    // Verify redaction masks are present
    expect(stored?.question).toContain('[REDACTED:');
    expect(stored?.context).toContain('[REDACTED:');

    // Verify the redaction hash is stored for exact-match memory lookup
    expect(stored?.input_hash).toBe(expectedInputHash);

    // Verify path and confidence that actually produced the answer
    expect(stored?.path).toBe('check');
    expect(stored?.confidence).toBe(0.99);
    expect(stored?.latency_ms).toBe(8);
  });

  it('records path, confidence, latency and session that actually produced the answer', () => {
    const question: ChoiceQuestion = {
      id: 'q-choice-1',
      type: 'choice',
      text: 'Select the cookie consent action',
      options: [{ id: 'accept_all' }, { id: 'reject_all' }, { id: 'customize' }],
    };

    const sessionObj = store.sessions.create({
      agent_name: 'test-logger-agent',
    });

    // Test object call style
    const decision1 = logDecision({
      question,
      answer: { value: 'accept_all' },
      path: 'memory',
      confidence: 0.98,
      latencyMs: 1.45,
      session: sessionObj,
      store,
    });

    expect(decision1.path).toBe('memory');
    expect(decision1.confidence).toBe(0.98);
    expect(decision1.latency_ms).toBe(1.45);
    expect(decision1.session_id).toBe(sessionObj.id);
    expect(decision1.decision_type).toBe('choice');

    // Test positional call style via log alias
    const decision2 = log(
      'Is the element a login wall?',
      true,
      'pattern',
      0.91,
      4.2,
      sessionObj.id,
      { store },
    );

    expect(decision2.path).toBe('pattern');
    expect(decision2.confidence).toBe(0.91);
    expect(decision2.latency_ms).toBe(4.2);
    expect(decision2.session_id).toBe(sessionObj.id);
    expect(decision2.decision_type).toBe('check');
  });

  it('rejects invalid path or confidence', () => {
    expect(() =>
      logDecision({
        question: 'Is this safe?',
        answer: true,
        path: 'magic' as unknown as 'check',
        confidence: 0.9,
        store,
      }),
    ).toThrow(SchemaViolationException);

    expect(() =>
      logDecision({
        question: 'Is this safe?',
        answer: true,
        path: 'check',
        confidence: 1.5,
        store,
      }),
    ).toThrow(SchemaViolationException);

    expect(() =>
      logDecision({
        question: 'Is this safe?',
        answer: true,
        path: 'check',
        confidence: -0.1,
        store,
      }),
    ).toThrow(SchemaViolationException);
  });

  it('records advisory safety check without preventing agent action', () => {
    expect(isSafetyAdvisory()).toBe(true);

    const safetyDecision = logDecision({
      question: 'Is this action potentially dangerous?',
      answer: 'blocked_action',
      path: 'human',
      confidence: 0.5,
      isSafety: true,
      store,
    });

    const stored = store.decisions.getById(safetyDecision.id);
    expect(stored?.is_safety).toBe(1);
    expect(stored?.path).toBe('human');
  });
});
