import type { ReactNode } from 'react';

export interface Metric {
  label: string;
  value: ReactNode;
  note?: string;
}

/** Joined cells: the container draws the lines, each cell is one metric. */
export function MetricGrid({ metrics }: { metrics: readonly Metric[] }) {
  return (
    <div className="metric-grid">
      {metrics.map((metric) => (
        <div className="metric-cell" key={metric.label}>
          <div className="card-label">{metric.label}</div>
          <div className="card-value">{metric.value}</div>
          {metric.note ? <div className="muted mono">{metric.note}</div> : null}
        </div>
      ))}
    </div>
  );
}
