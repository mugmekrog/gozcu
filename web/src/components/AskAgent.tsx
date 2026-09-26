/* The copilot input.
 *
 * Read-only by construction on the backend -- the tool registry has no mutator --
 * so the worst a question can do is cost a fraction of a cent. When there is no
 * gateway the field is disabled and says why, rather than accepting a question it
 * cannot answer and failing after the operator has typed it.
 */

import { memo, useId, useState } from 'react';
import { T } from '@/domain/strings';
import './ask-agent.css';

export interface AskAgentProps {
  available: boolean;
  onAsk: (question: string) => Promise<string>;
}

export const AskAgent = memo(function AskAgent({ available, onAsk }: AskAgentProps) {
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
          placeholder={available ? T.agent.askPlaceholder : T.agent.askOffline}
          disabled={!available || asking}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn--action"
          disabled={!available || asking || question.trim().length === 0}
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
