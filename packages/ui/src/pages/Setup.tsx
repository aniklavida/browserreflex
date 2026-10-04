import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Pack } from '../api';
import { SegmentedControl } from '../components/SegmentedControl';
import { useToast } from '../components/Toast';

const STEPS = ['Agent', 'Mode', 'Packs', 'Test'] as const;
export const POLL_MS = 3000;

export const AGENTS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'gemini-cli', label: 'Gemini CLI' },
] as const;

export const INIT_COMMAND = 'node packages/cli/dist/bin.js init';

export const MCP_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      browserreflex: { command: 'node', args: ['packages/cli/dist/bin.js', 'serve'] },
    },
  },
  null,
  2,
);

type Mode = 'chat' | 'byok';

export function Setup() {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>('chat');
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [firstDecision, setFirstDecision] = useState(false);
  const notify = useToast();

  useEffect(() => {
    if (step !== 2) return;
    api
      .packs()
      .then((page) => setPacks(page.items))
      .catch(() => setPacks([]));
  }, [step]);

  useEffect(() => {
    if (step !== 3) return undefined;
    let stopped = false;
    const check = () => {
      api
        .stats()
        .then((stats) => {
          if (!stopped && stats.decisions.total > 0) setFirstDecision(true);
        })
        .catch(() => undefined);
    };
    check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [step]);

  const copy = (text: string) => {
    try {
      void navigator.clipboard.writeText(text);
      notify('Copied', 'auto');
    } catch {
      notify('Could not copy', 'human');
    }
  };

  const saveMode = async () => {
    try {
      await api.putSetting('mode', mode);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save the mode', 'human');
    }
  };

  const next = async () => {
    if (step === 1) await saveMode();
    setStep((value) => Math.min(value + 1, STEPS.length - 1));
  };

  return (
    <div className="wizard grid-paper">
      <div className="wizard-card">
        <div className="wizard-steps">
          {STEPS.map((label, index) => (
            <div key={label} className={index === step ? 'current' : index < step ? 'done' : ''}>
              {index + 1} · {label}
            </div>
          ))}
        </div>
        <div className="wizard-body">
          {step === 0 ? (
            <>
              <h2>Connect your agent</h2>
              <p className="muted">
                Run the init command. It finds the agents installed on this machine and adds
                BrowserReflex to their MCP configuration, keeping a backup of each file.
              </p>
              <div className="metric-grid">
                {AGENTS.map((agent) => (
                  <div className="metric-cell" key={agent.id}>
                    <strong>{agent.label}</strong>
                    <div className="mono muted">{agent.id}</div>
                  </div>
                ))}
              </div>
              <div className="codeblock">{INIT_COMMAND}</div>
              <div className="row">
                <button type="button" className="btn" onClick={() => copy(INIT_COMMAND)}>
                  Copy command
                </button>
                <button type="button" className="btn" onClick={() => copy(MCP_SNIPPET)}>
                  Copy manual config
                </button>
              </div>
              <span className="muted">
                Run it from a source checkout. The package is not published yet, so there is no
                one-line install.
              </span>
            </>
          ) : null}
          {step === 1 ? (
            <>
              <h2>How should new questions be answered?</h2>
              <SegmentedControl<Mode>
                label="Mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'chat', label: 'Chat mode (no key)' },
                  { value: 'byok', label: 'Your own key' },
                ]}
              />
              <p className="muted">
                {mode === 'chat'
                  ? 'Your agent answers new questions in its own conversation and BrowserReflex remembers the answer.'
                  : 'BrowserReflex asks your provider itself. This mode is experimental and tested with fixtures only. Entering the key is planned: this wizard saves the mode, not the key.'}
              </p>
            </>
          ) : null}
          {step === 2 ? (
            <>
              <h2>Pattern packs</h2>
              {packs === null ? <span className="muted">Loading…</span> : null}
              {packs !== null && packs.length === 0 ? (
                <div className="empty">
                  <strong>No packs listed</strong>
                  <span>
                    The browser pack is loaded by the server at start-up. Pack switches on this page
                    are planned.
                  </span>
                </div>
              ) : null}
              {packs?.map((pack) => (
                <div className="row" key={pack.id} style={{ justifyContent: 'space-between' }}>
                  <div>
                    <strong>{pack.name}</strong>
                    <div className="muted">{pack.description ?? ''}</div>
                  </div>
                  <span className="chip">{pack.active ? 'active' : 'off'}</span>
                </div>
              ))}
            </>
          ) : null}
          {step === 3 ? (
            <>
              <h2>{firstDecision ? 'First decision received' : 'Waiting for your agent'}</h2>
              <p className="muted">
                {firstDecision
                  ? 'BrowserReflex has recorded a decision from your agent. Setup is done.'
                  : 'Ask your agent to do a browser task. This page checks every few seconds for the first recorded decision.'}
              </p>
              {firstDecision ? (
                <Link
                  to="/"
                  className="btn btn-primary"
                  style={{ textDecoration: 'none', width: 'fit-content' }}
                >
                  Open the dashboard
                </Link>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="wizard-footer">
          <button
            type="button"
            className="btn"
            disabled={step === 0}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
          >
            Back
          </button>
          <div className="row">
            <Link to="/" className="btn" style={{ textDecoration: 'none' }}>
              Skip setup
            </Link>
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={() => void next()}>
                Continue
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
