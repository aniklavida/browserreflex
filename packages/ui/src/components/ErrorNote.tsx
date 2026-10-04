/** A failed request is shown, never swallowed. */
export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="warn" role="alert">
      <strong>Could not load.</strong> {message}
    </div>
  );
}
