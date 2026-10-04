import { useState } from 'react';
import { api, ApiError } from '../api';
import { Card } from '../components/Card';
import { ErrorNote } from '../components/ErrorNote';
import { SegmentedControl } from '../components/SegmentedControl';
import { useToast } from '../components/Toast';
import { shortTime } from '../format';
import { applyTheme, readStoredTheme, storeTheme, type Theme } from '../theme';
import { useApi } from '../useApi';

export const PURGE_WORD = 'DELETE';
type Days = '30' | '90' | '365';

/** What is masked before anything is stored, from the redaction rules. */
export const REDACTED_KINDS = [
  'API keys',
  'Tokens',
  'Passwords',
  'Private keys',
  'Card numbers',
  'Cookies',
  'Emails',
  'Phone numbers',
  'URL credentials',
] as const;

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Settings() {
  const data = useApi(() => api.data());
  const notify = useToast();
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [days, setDays] = useState<Days>('90');
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  const changeTheme = (next: Theme) => {
    setTheme(next);
    storeTheme(next);
    applyTheme(next);
  };

  const backup = async () => {
    try {
      const result = await api.backup();
      notify(`Backed up ${result.file}`, 'auto');
      data.reload();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not back up', 'human');
    }
  };

  const purge = async () => {
    try {
      const result = await api.purge(Number(days));
      notify(`Deleted ${result.deleted} decisions`, 'ai');
      setConfirming(false);
      setTyped('');
      data.reload();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not delete', 'human');
    }
  };

  if (data.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={data.error} />
      </div>
    );
  }

  const info = data.data;

  return (
    <div className="page">
      <div className="cols-2">
        <Card label="Data">
          <div className="stack">
            <div className="mono">
              {info?.database_file ?? 'in-memory'} · {formatBytes(info?.size_bytes ?? null)}
            </div>
            <div>
              {info?.decisions ?? 0} decisions
              {info?.oldest_decision ? `, the oldest from ${shortTime(info.oldest_decision)}` : ''}
            </div>
            <div className="card-label">Delete old decisions</div>
            <div className="row">
              <SegmentedControl<Days>
                label="Older than"
                value={days}
                onChange={setDays}
                options={[
                  { value: '30', label: '30 days' },
                  { value: '90', label: '90 days' },
                  { value: '365', label: '1 year' },
                ]}
              />
              <button type="button" className="btn" onClick={() => setConfirming(true)}>
                Delete older…
              </button>
            </div>
            {confirming ? (
              <div className="warn stack" role="alertdialog" aria-label="Confirm delete">
                <span>
                  This deletes every decision older than {days} days for good. Type {PURGE_WORD} to
                  confirm.
                </span>
                <input
                  type="text"
                  aria-label="Type DELETE"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-inverted"
                    disabled={typed !== PURGE_WORD}
                    onClick={() => void purge()}
                  >
                    Delete for good
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            <span className="muted">
              Nothing is deleted automatically. Deleting happens only when you confirm it here.
            </span>
          </div>
        </Card>
        <Card label="Backup">
          <div className="stack">
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: 'fit-content' }}
              onClick={() => void backup()}
            >
              Back up now
            </button>
            {info !== null && info !== undefined && info.backups.length > 0 ? (
              <ul className="stack" style={{ margin: 0, paddingLeft: 18 }}>
                {info.backups.map((entry) => (
                  <li key={entry.file} className="mono">
                    {entry.file} · {formatBytes(entry.size_bytes)}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">No backup yet. A backup is a copy of the database file.</span>
            )}
            <span className="muted">
              Restoring is not built: to restore, stop the server and copy a backup file over the
              database file by hand.
            </span>
          </div>
        </Card>
      </div>
      <div className="cols-2">
        <Card label="Appearance">
          <SegmentedControl<Theme>
            label="Theme"
            value={theme}
            onChange={changeTheme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
        </Card>
        <Card label="Privacy">
          <div className="stack">
            <div className="row">
              {REDACTED_KINDS.map((kind) => (
                <span className="chip" key={kind}>
                  {kind}
                </span>
              ))}
            </div>
            <span className="muted">
              These are masked before anything is stored or logged. Anything not listed is not
              covered by redaction.
            </span>
            <strong>No telemetry.</strong>
            <span className="muted">
              BrowserReflex sends nothing to any host, and there is no switch for it because there
              is nothing to switch.
            </span>
          </div>
        </Card>
      </div>
      <Card label="Team mode">
        <span className="muted">Not available. Team mode is planned.</span>
      </Card>
    </div>
  );
}
