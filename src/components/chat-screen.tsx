"use client";

import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import {
  assembleChatMessages,
  buildSystemContext,
  MAX_USER_MESSAGE_LENGTH,
  type HistoryMessage,
} from "@/lib/chat/context";
import { useLastViewedMonster } from "@/lib/chat/last-monster";
import { streamChat, type ChatErrorKind } from "@/lib/chat/stream-client";
import { repository as defaultRepository, type Character, type Repository } from "@/lib/db";

export type ChatScreenProps = {
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: Repository;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/** One question and the assistant's (possibly streaming or failed) answer. */
type Turn = {
  id: string;
  question: string;
  answer: string;
  status: "streaming" | "done" | "error";
  error?: { kind: ChatErrorKind; message: string; interrupted: boolean };
};

/** Prior turns as chat history; only successfully answered turns are sent. */
function historyFrom(turns: readonly Turn[]): HistoryMessage[] {
  return turns
    .filter((turn) => turn.status === "done")
    .flatMap((turn) => [
      { role: "user" as const, content: turn.question },
      { role: "assistant" as const, content: turn.answer },
    ]);
}

/*
 * Flow: sending appends a turn and streams its answer delta by delta. Only one
 * answer streams at a time (send and retry are disabled meanwhile); clearing
 * or unmounting aborts it. Each request carries a fresh system context built
 * from the party roster and the last-viewed monster, plus prior answered turns.
 * The log is a polite live region marked aria-busy while streaming, so screen
 * readers announce the finished answer rather than every delta.
 */
export function ChatScreen({ repo = defaultRepository, fetchImpl }: ChatScreenProps) {
  const inputId = useId();
  const hintId = useId();
  const lastMonster = useLastViewedMonster();
  const [party, setParty] = useState<Character[] | null>(null);
  const [partyError, setPartyError] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    repo.characters.getAll().then(
      (all) => {
        if (active) setParty(all);
      },
      () => {
        if (!active) return;
        setParty([]);
        setPartyError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [repo]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const streaming = turns.some((turn) => turn.status === "streaming");
  const question = draft.trim();
  const canSend = party !== null && !streaming && question.length > 0;

  function updateTurn(id: string, change: (turn: Turn) => Turn) {
    setTurns((all) => all.map((turn) => (turn.id === id ? change(turn) : turn)));
  }

  async function answer(turn: Pick<Turn, "id" | "question">, earlier: readonly Turn[]) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    const messages = assembleChatMessages({
      systemContext: buildSystemContext({ party: party ?? [], lastMonster }),
      history: historyFrom(earlier),
      userMessage: turn.question,
    });
    try {
      const result = await streamChat(messages, {
        signal: controller.signal,
        fetchImpl,
        onDelta: (delta) => {
          if (!controller.signal.aborted) {
            updateTurn(turn.id, (t) => ({ ...t, answer: t.answer + delta }));
          }
        },
      });
      if (controller.signal.aborted) return;
      updateTurn(turn.id, (t) =>
        result.ok
          ? { ...t, answer: result.text, status: "done" }
          : {
              ...t,
              answer: result.text,
              status: "error",
              error: { kind: result.kind, message: result.message, interrupted: result.interrupted },
            },
      );
    } catch {
      // Aborted by clearing the conversation or unmounting.
    }
  }

  function send() {
    if (!canSend) return;
    const turn: Turn = { id: crypto.randomUUID(), question, answer: "", status: "streaming" };
    const earlier = turns;
    setTurns([...earlier, turn]);
    setDraft("");
    void answer(turn, earlier);
  }

  function retry(turn: Turn) {
    if (streaming) return;
    const index = turns.findIndex((t) => t.id === turn.id);
    updateTurn(turn.id, (t) => ({ ...t, answer: "", status: "streaming", error: undefined }));
    void answer(turn, turns.slice(0, index));
  }

  function clear() {
    controllerRef.current?.abort();
    setTurns([]);
    inputRef.current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  const contextNote =
    party === null
      ? "Loading party…"
      : `Using: ${party.length > 0 ? `party (${party.length})` : "no party"} · ${
          lastMonster ? lastMonster.name : "no monster"
        }`;

  return (
    <div className="chat-screen">
      <p className="chat-screen__context">{contextNote}</p>
      {partyError && (
        <p role="alert" className="chat-screen__error">
          Couldn&apos;t load the party, so answers won&apos;t include it.
        </p>
      )}

      <div
        role="log"
        aria-live="polite"
        aria-busy={streaming}
        aria-label="Conversation"
        className="chat-log"
      >
        {turns.length === 0 ? (
          <p className="chat-log__empty">
            Ask for a ruling, a dice recommendation, or help running an encounter.
          </p>
        ) : (
          <ol className="chat-log__list">
            {turns.map((turn) => (
              <Fragment key={turn.id}>
                <li className="chat-message chat-message--user">
                  <span className="chat-message__author">You</span>
                  <p className="chat-message__text">{turn.question}</p>
                </li>
                <li
                  className={`chat-message chat-message--assistant chat-message--${turn.status}`}
                  aria-busy={turn.status === "streaming"}
                >
                  <span className="chat-message__author">Assistant</span>
                  {turn.answer && <p className="chat-message__text">{turn.answer}</p>}
                  {turn.status === "streaming" && !turn.answer && (
                    <p className="chat-message__thinking">Thinking…</p>
                  )}
                  {turn.status === "error" && turn.error && (
                    <div role="alert" className="chat-message__error">
                      <p>
                        {turn.error.interrupted
                          ? `The answer was interrupted. ${turn.error.message}`
                          : turn.error.message}
                      </p>
                      <button
                        type="button"
                        className="chat-message__retry"
                        onClick={() => retry(turn)}
                        disabled={streaming}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        )}
      </div>

      <p role="status" className="chat-screen__status">
        {streaming ? "The assistant is answering…" : ""}
      </p>

      <form className="chat-input" onSubmit={handleSubmit}>
        <label htmlFor={inputId} className="chat-input__label">
          Ask the assistant
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          className="chat-input__field"
          rows={3}
          maxLength={MAX_USER_MESSAGE_LENGTH}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-describedby={hintId}
        />
        <p id={hintId} className="chat-input__hint">
          Enter to send, Shift+Enter for a new line.
        </p>
        <div className="chat-input__actions">
          <button type="submit" className="chat-input__send" disabled={!canSend}>
            Send
          </button>
          <button
            type="button"
            className="chat-input__clear"
            onClick={clear}
            disabled={turns.length === 0}
          >
            Clear conversation
          </button>
        </div>
      </form>
    </div>
  );
}
