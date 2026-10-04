import type { ReactNode } from 'react';

export function Card({
  label,
  children,
  safety = false,
}: {
  label?: string;
  children: ReactNode;
  safety?: boolean;
}) {
  return (
    <section className={`card${safety ? ' safety' : ''}`}>
      {label ? <div className="card-label">{label}</div> : null}
      {children}
    </section>
  );
}
