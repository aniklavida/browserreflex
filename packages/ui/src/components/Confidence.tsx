import type { DecisionPath } from '../api';
import { toneForPath } from './PathBadge';

/** Two decimals in the tone of the path that produced the answer. */
export function Confidence({ value, path }: { value: number; path: DecisionPath }) {
  return <span className={`conf mono tone-${toneForPath(path)}`}>{value.toFixed(2)}</span>;
}
