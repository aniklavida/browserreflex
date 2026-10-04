import { api } from '../api';
import { Card } from '../components/Card';
import { ErrorNote } from '../components/ErrorNote';
import { useApi } from '../useApi';

export function Integrations() {
  const clients = useApi(() => api.integrations());

  if (clients.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={clients.error} />
      </div>
    );
  }

  const origin = window.location.origin;

  return (
    <div className="page">
      <Card label="MCP clients">
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Configuration file</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {clients.data?.clients.map((client) => (
              <tr key={client.id}>
                <td>{client.label}</td>
                <td className="mono">~/{client.config_file}</td>
                <td>
                  <span className="chip">
                    {client.configured
                      ? 'configured'
                      : client.found
                        ? 'not configured'
                        : 'not found'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Run the setup wizard&apos;s init command to add BrowserReflex to a configuration. This
          page only reads those files.
        </p>
      </Card>
      <Card label="Local REST API">
        <div className="stack">
          <span>
            Served on this machine only, at <span className="mono">{origin}</span>. It has no key:
            only local requests with a local Host header are answered.
          </span>
          <div className="codeblock">curl {origin}/api/stats</div>
          <span className="muted">
            A public REST decide endpoint, webhooks and an HTTP transport for the MCP server are{' '}
            <strong>planned</strong>; nothing here sends data to another host.
          </span>
        </div>
      </Card>
    </div>
  );
}
