import { useState } from 'react';
import { api, ApiError, type KeyInfo, type KeyTestResult } from '../api';
import { useApi } from '../useApi';
import { ErrorNote } from './ErrorNote';
import { useToast } from './Toast';

export const PROVIDER = 'anthropic';

/** What a failed connection test says, from the adapter's own error codes. */
export const TEST_ERRORS: Record<string, string> = {
  no_key: 'No key is stored.',
  auth: 'The provider refused the key.',
  rate_limited: 'The provider is rate limiting this key.',
  timeout: 'The provider did not answer in time.',
  transport: 'The request could not reach the provider.',
  http_error: 'The provider answered with an error.',
  invalid_output: 'The provider answered in a form this build does not read.',
  config: 'The model setting is not usable.',
  no_answer: 'The provider answered no question.',
};

/**
 * Store, test and remove a provider key. The key goes to the operating system keychain (or an
 * encrypted file) through the local API. It is never shown again: the page holds the masked
 * form only, and the input is cleared as soon as the key is sent.
 */
export function KeySection() {
  const keys = useApi(() => api.keys());
  const notify = useToast();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeyTestResult | null>(null);

  const info: KeyInfo | undefined = keys.data?.items.find((item) => item.provider === PROVIDER);

  const save = async () => {
    if (value.trim() === '' || busy) return;
    setBusy(true);
    try {
      await api.putKey(PROVIDER, value.trim());
      setValue('');
      setResult(null);
      notify('Key stored', 'auto');
      keys.reload();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not store the key', 'human');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.testKey(PROVIDER));
    } catch (error) {
      setResult({
        ok: false,
        provider: PROVIDER,
        error: error instanceof ApiError ? error.message : 'transport',
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteKey(PROVIDER);
      setResult(null);
      notify('Key removed', 'auto');
      keys.reload();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not remove the key', 'human');
    } finally {
      setBusy(false);
    }
  };

  if (keys.error !== null) return <ErrorNote message={keys.error} />;

  return (
    <div className="stack">
      <div className="card-label">Anthropic key</div>
      {info?.has_key ? (
        <div className="row">
          <span className="mono" aria-label="Stored key">
            {info.masked}
          </span>
          <span className="chip">{info.backend}</span>
        </div>
      ) : (
        <span className="muted">No key is stored.</span>
      )}
      <div className="row">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label="Provider key"
          placeholder={info?.has_key ? 'Paste a new key to replace it' : 'Paste your key'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          style={{ maxWidth: 360 }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || value.trim() === ''}
          onClick={() => void save()}
        >
          Store key
        </button>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={busy || !info?.has_key}
          onClick={() => void test()}
        >
          Test connection
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !info?.has_key}
          onClick={() => void remove()}
        >
          Remove key
        </button>
      </div>
      {result !== null ? (
        <div className={result.ok ? 'card' : 'warn'} role="status">
          {result.ok
            ? `Connected: ${result.model ?? 'model'} answered in ${result.latency_ms ?? '?'} ms.`
            : (TEST_ERRORS[result.error ?? ''] ?? `The test failed: ${result.error ?? 'unknown'}.`)}
        </div>
      ) : null}
      <span className="muted">
        The key goes to your operating system keychain, or an encrypted file when no keychain is
        available. It is never shown again, never written to the settings or the logs, and
        &quot;Test connection&quot; makes one small request to the provider. Bring-your-own-key mode
        is experimental: it has been tested with fixtures only.
      </span>
    </div>
  );
}
