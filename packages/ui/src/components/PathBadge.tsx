import type { DecisionPath } from '../api';

/** Green is automatic, yellow is a model, red is a person: these tones mean nothing else. */
export type Tone = 'auto' | 'ai' | 'human';

export function toneForPath(path: DecisionPath): Tone {
  if (path === 'ai') return 'ai';
  if (path === 'human') return 'human';
  return 'auto';
}

export function PathBadge({ path }: { path: DecisionPath }) {
  return (
    <span className={`pathbadge tone-${toneForPath(path)}`} data-path={path}>
      <span className="dot" />
      {path}
    </span>
  );
}
