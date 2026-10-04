import { api, ApiError, type Pack } from '../api';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { SquareToggle } from '../components/SquareToggle';
import { useToast } from '../components/Toast';
import { useApi } from '../useApi';

export function Packs() {
  const packs = useApi(() => api.packs());
  const notify = useToast();

  if (packs.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={packs.error} />
      </div>
    );
  }
  if (packs.data === null) {
    return <div className="page muted">Loading…</div>;
  }

  const set = async (pack: Pack, active: boolean) => {
    try {
      const result = await api.setPack(pack.id, active);
      notify(result.note, active ? 'auto' : 'ai');
      packs.reload();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not switch the pack', 'human');
    }
  };

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">
          A pack that is off stops answering with its non-safety rules; those questions go to your
          agent. Its safety rules keep working.
        </span>
        <button type="button" className="btn" disabled title="Planned">
          Import pack file (planned)
        </button>
      </div>
      {packs.data.items.length === 0 ? (
        <EmptyState title="No packs registered">
          The browser pack is registered when the MCP server starts. Start your agent once and come
          back.
        </EmptyState>
      ) : (
        <div className="cols-2">
          {packs.data.items.map((pack) => (
            <Card key={pack.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <strong style={{ fontSize: 18 }}>{pack.name}</strong>
                  <div className="mono muted">
                    v{pack.version} · {pack.id}
                  </div>
                </div>
                <SquareToggle
                  label={`${pack.name} on`}
                  checked={Boolean(pack.is_active)}
                  onChange={(checked) => void set(pack, checked)}
                />
              </div>
              <p>{pack.description ?? 'No description.'}</p>
              <span className="chip">unsigned</span>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
