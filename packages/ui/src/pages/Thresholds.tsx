import { useEffect, useState } from 'react';
import { api, type DecisionType } from '../api';
import { Card } from '../components/Card';
import { ErrorNote } from '../components/ErrorNote';
import { useToast } from '../components/Toast';
import { useApi } from '../useApi';

export const THRESHOLD_KEY = 'thresholds';
export const TYPES: readonly DecisionType[] = ['choice', 'score', 'check'];

/** The ranges the server enforces: human below 10 to 80 percent, auto at or above 50 to 99. */
export const HUMAN_MIN = 10;
export const HUMAN_MAX = 80;
export const AUTO_MIN = 50;
export const AUTO_MAX = 99;

export interface Split {
  human_below: number;
  auto_at_or_above: number;
}

export type Splits = Record<DecisionType, Split>;

export const DEFAULT_SPLITS: Splits = {
  choice: { human_below: 20, auto_at_or_above: 80 },
  score: { human_below: 20, auto_at_or_above: 80 },
  check: { human_below: 20, auto_at_or_above: 80 },
};

/** The safety rules that are always on in this build. None of them can be switched off here. */
export const SAFETY_GATES = [
  {
    id: 'payment',
    label: 'Payment controls',
    note: 'Pay, place order, wallet buttons, checkout steps',
  },
  {
    id: 'destructive',
    label: 'Destructive actions',
    note: 'Delete, wipe, remove all, force push, reset --hard',
  },
  { id: 'outbound', label: 'Outbound messages', note: 'Send, post, publish, share, email' },
  {
    id: 'secrets',
    label: 'Secrets in typed text',
    note: 'Credentials and card numbers answer block',
  },
] as const;

/** Reads the stored thresholds, in percent, falling back to the defaults for anything missing. */
export function parseSplits(raw: string | undefined): Splits {
  const result: Splits = JSON.parse(JSON.stringify(DEFAULT_SPLITS)) as Splits;
  if (raw === undefined) return result;
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      { human_below?: number; auto_at_or_above?: number }
    >;
    for (const type of TYPES) {
      const entry = parsed[type];
      if (entry === undefined) continue;
      if (typeof entry.human_below === 'number')
        result[type].human_below = toPercent(entry.human_below);
      if (typeof entry.auto_at_or_above === 'number') {
        result[type].auto_at_or_above = toPercent(entry.auto_at_or_above);
      }
    }
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SPLITS)) as Splits;
  }
  return result;
}

function toPercent(value: number): number {
  return Math.round(value > 1 ? value : value * 100);
}

/** The reason a split cannot be saved, or null when it can. */
export function splitProblem(split: Split): string | null {
  if (split.human_below < HUMAN_MIN || split.human_below > HUMAN_MAX) {
    return `Human below must be between ${HUMAN_MIN}% and ${HUMAN_MAX}%.`;
  }
  if (split.auto_at_or_above < AUTO_MIN || split.auto_at_or_above > AUTO_MAX) {
    return `Auto at or above must be between ${AUTO_MIN}% and ${AUTO_MAX}%.`;
  }
  if (split.human_below > split.auto_at_or_above) {
    return 'The two thresholds cannot cross.';
  }
  return null;
}

export function Thresholds() {
  const settings = useApi(() => api.settings());
  const notify = useToast();
  const [splits, setSplits] = useState<Splits>(DEFAULT_SPLITS);

  useEffect(() => {
    if (settings.data !== null) {
      setSplits(parseSplits(settings.data.settings.find((s) => s.key === THRESHOLD_KEY)?.value));
    }
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

  const change = (type: DecisionType, field: keyof Split, value: number) => {
    setSplits((previous) => ({ ...previous, [type]: { ...previous[type], [field]: value } }));
  };

  const problem = TYPES.map((type) => splitProblem(splits[type])).find((value) => value !== null);

  const save = async () => {
    try {
      const payload: Record<string, Split> = {};
      for (const type of TYPES) {
        payload[type] = {
          human_below: splits[type].human_below / 100,
          auto_at_or_above: splits[type].auto_at_or_above / 100,
        };
      }
      await api.putSetting(THRESHOLD_KEY, payload);
      notify('Thresholds saved', 'auto');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save', 'human');
    }
  };

  return (
    <div className="page">
      <div className="cols-2">
        <div className="stack">
          {TYPES.map((type) => {
            const split = splits[type];
            const ai = Math.max(0, split.auto_at_or_above - split.human_below);
            return (
              <Card key={type} label={`${type} questions`}>
                <div className="splitbar" aria-label={`${type} split`}>
                  <span className="seg-human" style={{ width: `${split.human_below}%` }}>
                    {split.human_below >= 14 ? `YOU ${split.human_below}%` : ''}
                  </span>
                  <span className="seg-ai" style={{ width: `${ai}%` }}>
                    {ai >= 14 ? `MODEL ${ai}%` : ''}
                  </span>
                  <span className="seg-auto" style={{ width: `${100 - split.auto_at_or_above}%` }}>
                    {100 - split.auto_at_or_above >= 14
                      ? `AUTO ${100 - split.auto_at_or_above}%`
                      : ''}
                  </span>
                </div>
                <label className="stack" style={{ marginTop: 12 }}>
                  <span className="card-label">Human below {split.human_below}%</span>
                  <input
                    type="range"
                    min={HUMAN_MIN}
                    max={HUMAN_MAX}
                    value={split.human_below}
                    aria-label={`${type} human below`}
                    onChange={(event) => change(type, 'human_below', Number(event.target.value))}
                  />
                </label>
                <label className="stack" style={{ marginTop: 8 }}>
                  <span className="card-label">Auto at or above {split.auto_at_or_above}%</span>
                  <input
                    type="range"
                    min={AUTO_MIN}
                    max={AUTO_MAX}
                    value={split.auto_at_or_above}
                    aria-label={`${type} auto at or above`}
                    onChange={(event) =>
                      change(type, 'auto_at_or_above', Number(event.target.value))
                    }
                  />
                </label>
              </Card>
            );
          })}
          {problem ? <div className="warn">{problem}</div> : null}
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={Boolean(problem)}
              onClick={() => void save()}
            >
              Save thresholds
            </button>
          </div>
        </div>
        <Card label="Safety gates" safety>
          <div className="warn" style={{ marginBottom: 12 }}>
            The safety check is advisory. It reports a request for you in your agent&apos;s own chat
            and does not stop an agent from acting.
          </div>
          <div className="stack">
            {SAFETY_GATES.map((gate) => (
              <div key={gate.id} className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <strong>{gate.label}</strong>
                  <div className="muted">{gate.note}</div>
                </div>
                <span className="chip chip-drift">always on</span>
              </div>
            ))}
            <span className="muted">
              These rules cannot be switched off in this build, and no threshold or learned pattern
              changes them.
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}
