// The conversation lives only in this component's state (per contracts: the gateway is stateless
// and the browser resends the history). Leaving the page or reloading starts a new conversation.
import { useMutation } from '@tanstack/react-query';
import type { ChatRequest, ChatResponse } from '@urumi/contracts';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api.js';
import { Badge } from '../components/ui.js';

// ChatRequestSchema limits.
const MAX_MESSAGES = 40;
const MAX_CONTENT = 8000;

type Turn =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls: ChatResponse['toolCalls'];
      toolMode?: ChatResponse['toolMode'];
      searches?: ChatResponse['discoverySearches'];
    };

/** Turns → request history: the newest 40 messages, starting with a user message. */
function toHistory(turns: Turn[]): ChatRequest['messages'] {
  const messages = turns.slice(-MAX_MESSAGES).map((t) => ({
    role: t.role,
    content: (t.content || '(empty reply)').slice(0, MAX_CONTENT),
  }));
  while (messages[0]?.role === 'assistant') messages.shift();
  return messages;
}

export function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chat = useMutation({ mutationFn: api.chat });

  function send() {
    const text = draft.trim();
    if (!text || chat.isPending) return;
    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setDraft('');
    setError(null);
    chat.mutate(
      { messages: toHistory(next) },
      {
        onSuccess: (res) =>
          setTurns((t) => [
            ...t,
            {
              role: 'assistant',
              content: res.reply,
              toolCalls: res.toolCalls,
              toolMode: res.toolMode,
              searches: res.discoverySearches,
            },
          ]),
        onError: (err) => {
          // Unanswered: take it back out of the history and return it to the box.
          setTurns((t) => t.slice(0, -1));
          setDraft(text);
          setError(errorMessage(err));
        },
      },
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <section className="chat">
      <div className="page-head">
        <h1>Chat</h1>
        <button
          type="button"
          className="secondary"
          disabled={turns.length === 0 || chat.isPending}
          onClick={() => {
            setTurns([]);
            setError(null);
          }}
        >
          New conversation
        </button>
      </div>
      <p className="muted">
        Ask about the store. The assistant uses your tools; every call is audited as you.
      </p>
      <ol className="chat-log">
        {turns.map((t, i) => (
          <li key={i} className={`turn ${t.role}`}>
            <div className="who">{t.role === 'user' ? 'You' : 'Assistant'}</div>
            <div className="text">{t.content}</div>
            {t.role === 'assistant' && (
              <ToolsUsed calls={t.toolCalls} mode={t.toolMode} searches={t.searches} />
            )}
          </li>
        ))}
        {chat.isPending && <li className="turn assistant pending">Thinking…</li>}
      </ol>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <form className="composer" onSubmit={onSubmit}>
        <label>
          Message
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={MAX_CONTENT}
            rows={3}
            placeholder="How many orders came in today?"
          />
        </label>
        <button type="submit" disabled={chat.isPending || draft.trim() === ''}>
          Send
        </button>
      </form>
    </section>
  );
}

function ToolsUsed({
  calls,
  mode,
  searches,
}: {
  calls: ChatResponse['toolCalls'];
  mode?: ChatResponse['toolMode'];
  searches?: ChatResponse['discoverySearches'];
}) {
  // Discovery mode (ADR 012): many permitted tools, so the model searched for them first.
  const discovery = mode === 'discovery' && (
    <div className="discovery-note" role="note">
      <strong>Discovery mode</strong>: you can use many tools, so the assistant searched for the
      right ones instead of receiving them all.
      {searches && searches.length > 0 && (
        <ul aria-label="Tool searches">
          {searches.map((s, i) => (
            <li key={i}>
              searched “{s.query}” → {s.resultCount} match{s.resultCount === 1 ? '' : 'es'}
              {s.top.length > 0 && (
                <>
                  {' '}
                  (<code>{s.top.join(', ')}</code>)
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  if (calls.length === 0)
    return (
      <div className="tools-used muted">
        {discovery}
        No tools used.
      </div>
    );
  return (
    <div className="tools-used">
      {discovery}
      <div className="label">{mode === 'discovery' ? 'Tools executed' : 'Tools used'}</div>
      <ul aria-label="Tools used">
        {calls.map((c, i) => (
          <li key={i}>
            <code>{c.name}</code>
            <span className="server">{c.serverSlug}</span>
            {c.via === 'discovery' && <span className="via">via gateway__call_tool</span>}
            <Badge value={c.outcome} />
            <span>{c.durationMs} ms</span>
            {c.errorCode && <span className="error small">{c.errorCode}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
