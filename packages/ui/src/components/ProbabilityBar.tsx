/** A 6 px bar whose fill width is a probability from 0 to 1. */
export function ProbabilityBar({
  value,
  suggested = false,
}: {
  value: number;
  suggested?: boolean;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div
      className={`probbar${suggested ? ' suggested' : ''}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={clamped}
    >
      <span style={{ width: `${(clamped * 100).toFixed(1)}%` }} />
    </div>
  );
}
