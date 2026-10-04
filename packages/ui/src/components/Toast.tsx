import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import type { Tone } from './PathBadge';

interface ToastItem {
  message: string;
  tone: Tone;
}

type Notify = (message: string, tone?: Tone) => void;

const ToastContext = createContext<Notify>(() => undefined);

export const TOAST_MS = 2600;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback<Notify>((message, tone = 'auto') => {
    if (timer.current !== null) clearTimeout(timer.current);
    setToast({ message, tone });
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      {toast ? (
        <div className={`toast tone-${toast.tone}`} role="status">
          <span className="dot" />
          {toast.message}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext);
}
