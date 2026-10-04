import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card } from '../components/Card';
import { ErrorNote } from '../components/ErrorNote';
import { SegmentedControl } from '../components/SegmentedControl';
import { useToast } from '../components/Toast';
import { useApi } from '../useApi';

export type Mode = 'chat' | 'byok';

export const MODE_KEY = 'mode';
export const PROVIDER_KEY = 'provider';
export const MODEL_KEY = 'provider.anthropic.model';
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export function Engines() {
  const settings = useApi(() => api.settings());
  const notify = useToast();
  const [mode, setMode] = useState<Mode>('chat');
  const [model, setModel] = useState('');

  useEffect(() => {
    if (settings.data === null) return;
    const read = (key: string) => settings.data?.settings.find((s) => s.key === key)?.value;
    setMode(read(MODE_KEY) === 'byok' ? 'byok' : 'chat');
    setModel(read(MODEL_KEY) ?? '');
  }, [settings.data]);

  if (settings.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={settings.error} />
      </div>
    );
  }
  if (settings.data === null) {
    return <div className="page muted">Loading…</div>;
  }

  const save = async () => {
    try {
      await api.putSetting(MODE_KEY, mode);
      if (mode === 'byok') {
        await api.putSetting(PROVIDER_KEY, 'anthropic');
        if (model.trim() !== '') await api.putSetting(MODEL_KEY, model.trim());
      }
      notify('Engine saved', 'auto');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save', 'human');
    }
  };

  return (
    <div className="page">
      <Card label="Mode">
        <div className="stack">
          <SegmentedControl<Mode>
            label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'chat', label: 'Chat mode (no key)' },
              { value: 'byok', label: 'Your own key' },
            ]}
          />
          {mode === 'chat' ? (
            <div className="metric-grid">
              {[
                ['Known question', 'Memory or a rule answers at once'],
                ['New question', 'Returned to your agent as needs_ai'],
                ['Your agent answers', 'It calls submit_answers'],
                ['Next time', 'The answer comes from memory'],
              ].map(([label, text]) => (
                <div className="metric-cell" key={label}>
                  <div className="card-label">{label}</div>
                  <div>{text}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="stack">
              <label className="stack">
                <span className="card-label">Provider</span>
                <select aria-label="Provider" value="anthropic" onChange={() => undefined}>
                  <option value="anthropic">Anthropic</option>
                </select>
              </label>
              <label className="stack">
                <span className="card-label">Model</span>
                <input
                  type="text"
                  aria-label="Model"
                  value={model}
                  placeholder={DEFAULT_MODEL}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
              <div className="warn">
                <strong>Entering a key here is planned.</strong> The local API refuses to store
                credentials by design, and the operating system keychain is not wired to this page
                yet. Your mode and model are saved; the key is not. Bring-your-own-key mode is
                experimental and has been tested with fixtures only, never against a live provider.
              </div>
              <div>
                <button type="button" className="btn" disabled title="Planned">
                  Test connection (planned)
                </button>
              </div>
            </div>
          )}
          <div>
            <button type="button" className="btn btn-primary" onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
