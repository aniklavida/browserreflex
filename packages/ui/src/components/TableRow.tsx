import type { KeyboardEvent, ReactNode } from 'react';

/** A table row that can be selected and opened from the keyboard. */
export function TableRow({
  children,
  selected = false,
  onOpen,
}: {
  children: ReactNode;
  selected?: boolean;
  onOpen?: () => void;
}) {
  const props =
    onOpen === undefined
      ? {}
      : {
          tabIndex: 0,
          onClick: onOpen,
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key === 'Enter') onOpen();
          },
          style: { cursor: 'pointer' },
        };
  return (
    <tr className={selected ? 'selected' : undefined} {...props}>
      {children}
    </tr>
  );
}
