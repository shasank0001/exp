import type { Message } from '../types';

interface ConversationProps {
  threadTitle: string | null;
  messages: Message[] | null;
  messagesError: string | null;
  streamingText: string;
  toolStatus: string | null;
  engineError: string | null;
  bridgeMissing: boolean;
  noThread: boolean;
  onRetry: () => void;
  onDismissEngineError: () => void;
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function Conversation(props: ConversationProps) {
  const {
    threadTitle, messages, messagesError, streamingText,
    toolStatus, engineError, bridgeMissing, noThread, onRetry, onDismissEngineError,
  } = props;

  return (
    <div className="conversation">
      <div className="intro">
        <div className="eyebrow"><span className="intro-rule" aria-hidden="true" /> Research thread</div>
        <h1>{threadTitle ?? 'A good baseline is a beginning.'}</h1>
        <p>Build, observe, and iterate. Keep the context.</p>
      </div>

      {engineError ? (
        <div className="banner error" role="alert">
          <span>{engineError}</span>
          <button className="btn quiet" onClick={onDismissEngineError}>Dismiss</button>
        </div>
      ) : null}

      {noThread ? (
        <div className="empty-state">
          <p>No thread selected. Create a thread to start a conversation.</p>
        </div>
      ) : bridgeMissing ? (
        <div className="empty-state">
          <p>Bridge unavailable. Messages can’t be loaded outside the Electron app.</p>
        </div>
      ) : messages === null ? (
        <div className="empty-state"><p>Loading messages…</p></div>
      ) : messagesError ? (
        <div className="empty-state">
          <p>Couldn’t load messages: {messagesError}</p>
          <button className="btn" onClick={onRetry}>Retry</button>
        </div>
      ) : messages.length === 0 && !streamingText ? (
        <div className="empty-state">
          <p>No messages yet. Send the first prompt below to begin.</p>
        </div>
      ) : (
        <div aria-live="polite" aria-relevant="additions">
          {messages.map((m) =>
            m.role === 'user' ? (
              <article key={m.id} className="chat-message user-message">
                <span className="avatar user-avatar" aria-hidden="true">You</span>
                <div className="content">
                  <div className="byline">You <span>{formatTime(m.createdAt)}</span></div>
                  <div className="user-bubble"><p>{m.text}</p></div>
                </div>
              </article>
            ) : (
              <article key={m.id} className="chat-message agent-message">
                <span className="avatar agent-avatar" aria-hidden="true">m/</span>
                <div className="content">
                  <div className="byline">ML Copilot <span>{formatTime(m.createdAt)}</span></div>
                  <p>{m.text}</p>
                </div>
              </article>
            ),
          )}
          {streamingText ? (
            <article className="chat-message agent-message" aria-label="Streaming reply">
              <span className="avatar agent-avatar" aria-hidden="true">m/</span>
              <div className="content">
                <div className="byline">ML Copilot <span>streaming…</span></div>
                <p>{streamingText}<span className="caret" aria-hidden="true">▍</span></p>
              </div>
            </article>
          ) : null}
        </div>
      )}

      {toolStatus ? (
        <div className="tool" role="status">
          <span aria-hidden="true">⚙</span>
          <span>{toolStatus}</span>
        </div>
      ) : null}
    </div>
  );
}
