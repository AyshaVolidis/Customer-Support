'use client';

// The chat UI. A thin wrapper: it posts to /api/chat and shows what comes back.
// No business logic here, and no runtime import from src/lib - the response
// type is imported with `import type`, which disappears at compile time.

import { useEffect, useRef, useState } from 'react';

import type { ChatResponse } from '@/lib/schema';

const SESSION_KEY = 'customer-support-session-id';

type Message = {
  role: 'user' | 'assistant' | 'error';
  text: string;
  /** Assistant only: the reply asked the customer to confirm something. */
  needsConfirmation?: boolean;
  /** Assistant only: the choices the reply offered. `id` is the option number. */
  options?: ChatResponse['options'];
};

/* --- Inline icons. No icon library. ------------------------------------- */

function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.5c-4.7 0-8.5 3.3-8.5 7.4 0 2.4 1.3 4.5 3.4 5.9v3.2l3.2-1.7c.6.1 1.2.2 1.9.2 4.7 0 8.5-3.3 8.5-7.6S16.7 3.5 12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11" r="1.5" fill="currentColor" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 7.5v5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1" fill="currentColor" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5m0 0-6 6m6-6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* --- Session id -------------------------------------------------------- */

/**
 * What clicking an option does: SHOW the label, SEND the id.
 *
 * The id is the temporary option number as a string ("1", "2", "3") - never a
 * real order id, which the server keeps to itself. Sending the label instead
 * would hand the backend free text like "Wireless headphones (ordered Oct 7)",
 * which the pending-reply classifier can read as a new topic.
 *
 * Exported so the mapping can be unit-tested without rendering.
 */
export function optionMessage(option: { id: string; label: string }): {
  /** Goes in the POST body as `message`. */
  sent: string;
  /** Goes in the customer's own bubble. */
  display: string;
} {
  return { sent: option.id, display: option.label };
}

/** A session id. randomUUID needs a secure context, so keep a fallback. */
function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Read the session id from sessionStorage, creating one on first visit.
 * sessionStorage can throw (private browsing), so every access is guarded.
 */
function loadSessionId(): string {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) return stored;
  } catch {
    return newSessionId();
  }

  const created = newSessionId();
  try {
    sessionStorage.setItem(SESSION_KEY, created);
  } catch {
    // Not stored, so a refresh starts a new conversation. Still usable.
  }
  return created;
}

export default function ChatClient() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);

  /**
   * The session id, created on first use and kept for the tab.
   *
   * Resolved lazily rather than in an effect: this only ever runs from a click
   * or a submit, so sessionStorage definitely exists and there is no state to
   * set during render.
   */
  function getSessionId(): string {
    sessionIdRef.current ??= loadSessionId();
    return sessionIdRef.current;
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending]);

  /**
   * Send one message.
   *
   * `sent` is what goes to the server; `display` is what the customer sees in
   * their own bubble. They are the same for typed text, and differ for an
   * option button, which shows a label but sends a number.
   */
  async function send(sent: string, display: string = sent): Promise<void> {
    setMessages((previous) => [...previous, { role: 'user', text: display }]);
    setInput('');
    setSending(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: getSessionId(), message: sent }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const reason =
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : 'Something went wrong. Please try again.';
        setMessages((previous) => [...previous, { role: 'error', text: reason }]);
        return;
      }

      // The body is validated on the server (gate G7). The client cannot import
      // the Zod schema at runtime, so check the fields it uses.
      const reply = body as ChatResponse | null;
      const answer = reply?.answer;
      setMessages((previous) => [
        ...previous,
        typeof answer === 'string' && answer.length > 0
          ? {
              role: 'assistant',
              text: answer,
              needsConfirmation: reply?.needsConfirmation === true,
              options: Array.isArray(reply?.options) ? reply.options : [],
            }
          : { role: 'error', text: 'I did not get a reply. Please try again.' },
      ]);
    } catch {
      setMessages((previous) => [
        ...previous,
        { role: 'error', text: 'I could not reach the server. Please check your connection.' },
      ]);
    } finally {
      setSending(false);
    }
  }

  // A form, so Enter submits without any key handling of our own.
  function onSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = input.trim();
    if (text.length === 0 || sending) return;
    void send(text);
  }

  /**
   * A button click. `sent` is the message text; `display` is the bubble text,
   * which only differs for an option button.
   */
  function onActionClick(sent: string, display: string = sent): void {
    if (sending) return;
    void send(sent, display);
  }

  const canSend = input.trim().length > 0 && !sending;

  // Only the newest assistant message keeps live buttons. Older ones are
  // disabled, so a stale "Yes" cannot be clicked after the flow has moved on.
  const lastAssistantIndex = messages.reduce(
    (last, message, index) => (message.role === 'assistant' ? index : last),
    -1,
  );

  return (
    <div className="chat">
      <header className="chat-header">
        <span className="brand-mark">
          <BrandMark />
        </span>
        <div>
          <h1>Customer Support Assistant</h1>
          <p className="status">
            <span className="status-dot" />
            Online
          </p>
        </div>
      </header>

      <div className="messages" role="log" aria-live="polite">
        {messages.length === 0 && !sending && (
          <div className="welcome">
            <span className="brand-mark">
              <BrandMark />
            </span>
            <h2>How can I help?</h2>
            <p>
              I can check an order&apos;s status, cancel an order, answer return, shipping and
              warranty questions, or put you through to a person.
            </p>
          </div>
        )}

        {messages.map((message, index) => {
          const isUser = message.role === 'user';
          // Only the first message of a run gets an avatar.
          const startsRun = index === 0 || messages[index - 1]?.role !== message.role;

          const options = message.options ?? [];
          const hasActions = message.needsConfirmation === true || options.length > 0;
          // Live only on the newest assistant message, and never mid-request.
          // A click adds messages, so the clicked row stops being the newest
          // and its buttons disable themselves.
          const actionsDisabled = sending || index !== lastAssistantIndex;

          return (
            <div
              // Messages are only appended, so the index is a stable key here.
              key={index}
              className={`row row--${message.role}`}
            >
              {!isUser &&
                (startsRun ? (
                  <span className="avatar">
                    {message.role === 'error' ? <AlertIcon /> : <AgentIcon />}
                  </span>
                ) : (
                  <span className="avatar-spacer" />
                ))}

              <div className="stack">
                <div
                  className={`bubble ${message.role}`}
                  data-testid={
                    isUser
                      ? 'message-user'
                      : message.role === 'assistant'
                        ? 'message-assistant'
                        : 'error-message'
                  }
                  dir="auto"
                >
                  {message.role === 'error' && <AlertIcon />}
                  <span>{message.text}</span>
                </div>

                {hasActions && (
                  <div className="actions">
                    {options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className="chip"
                        data-testid="option-button"
                        dir="auto"
                        disabled={actionsDisabled}
                        onClick={() => {
                          // Shows the label, sends the number.
                          const { sent, display } = optionMessage(option);
                          onActionClick(sent, display);
                        }}
                      >
                        {option.label}
                      </button>
                    ))}

                    {message.needsConfirmation === true && (
                      <>
                        <button
                          type="button"
                          className="btn-primary"
                          data-testid="confirm-yes"
                          disabled={actionsDisabled}
                          onClick={() => {
                            onActionClick('yes');
                          }}
                        >
                          Yes
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          data-testid="confirm-no"
                          disabled={actionsDisabled}
                          onClick={() => {
                            onActionClick('no');
                          }}
                        >
                          No
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {sending && (
          <div className="row row--assistant">
            <span className="avatar">
              <AgentIcon />
            </span>
            <div
              className="bubble assistant typing"
              data-testid="typing-indicator"
              aria-label="Assistant is typing"
            >
              <span />
              <span />
              <span />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={onSubmit}>
        <input
          data-testid="chat-input"
          type="text"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
          }}
          placeholder="Ask about an order, returns or shipping"
          aria-label="Your message"
          autoComplete="off"
          dir="auto"
          disabled={sending}
        />
        <button
          className="send"
          data-testid="send-button"
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
        >
          <SendIcon />
        </button>
      </form>
    </div>
  );
}
