/* The copilot input for questions and explicit evaluation requests. */

import { memo, useId, useState } from 'react';
import { T } from '@/domain/strings';
import './ask-agent.css';

export interface AskAgentProps {
  onAsk: (question: string) => Promise<string>;
}

export const AskAgent = memo(function AskAgent({ onAsk }: AskAgentProps) {
  const inputId = useId();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || asking) return;

    setAsking(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await onAsk(trimmed));
      setQuestion('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  }

  return (
    <section className="panel ask">
      <form className="ask__form" onSubmit={submit}>
        <label className="ask__label" htmlFor={inputId}>
          {T.agent.ask}
        </label>
        <input
          id={inputId}
          className="input ask__input"
          type="text"
          value={question}
          placeholder={T.agent.askPlaceholder}
          disabled={asking}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn--action"
          disabled={asking || question.trim().length === 0}
        >
          {asking ? '…' : T.agent.askSend}
        </button>
      </form>

      {answer && (
        <p className="ask__answer" role="status">
          {answer}
        </p>
      )}
      {error && (
        <p className="ask__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
});
