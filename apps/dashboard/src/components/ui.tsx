// Small shared pieces. Everything renders untrusted strings as React text, never as HTML.
import { useEffect, useState } from 'react';
import { errorMessage } from '../api.js';

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="error">
      {errorMessage(error)}
    </p>
  );
}

export function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

/** Status (up/down/unknown) or outcome (ok/error/timeout/denied/rate_limited) pill. */
export function Badge({ value }: { value: string }) {
  return <span className={`badge badge-${value}`}>{value}</span>;
}

// navigator.clipboard needs a secure context; plain-http deployments fall back to execCommand.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'offscreen';
  document.body.append(area);
  area.select();
  const ok = document.execCommand?.('copy') ?? false;
  area.remove();
  return ok;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => void copyText(text).then((ok) => setState(ok ? 'copied' : 'failed'))}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — select it' : label}
    </button>
  );
}
