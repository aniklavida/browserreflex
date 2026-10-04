import type { ReactNode } from 'react';

/** Every empty page says what will appear and what to do next. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <span>{children}</span>
      {action}
    </div>
  );
}
