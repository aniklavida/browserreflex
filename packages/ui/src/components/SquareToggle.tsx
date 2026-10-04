export function SquareToggle({
  checked,
  onChange,
  label,
  safety = false,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  safety?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${safety ? ' safety' : ''}`}
      onClick={() => onChange(!checked)}
    />
  );
}
