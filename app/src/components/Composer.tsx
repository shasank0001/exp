import type { KeyboardEvent } from 'react';

interface ComposerProps {
  draft: string;
  sending: boolean;
  streaming: boolean;
  canSend: boolean;
  sendDisabledReason: string | null;
  sendError: string | null;
  onDraft: (text: string) => void;
  onSend: () => void;
  onAbort: () => void;
}

export default function Composer(props: ComposerProps) {
  const { draft, sending, streaming, canSend, sendDisabledReason, sendError, onDraft, onSend, onAbort } = props;

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (canSend && draft.trim().length > 0) onSend();
    }
  }

  return (
    <div className="composer-dock">
      <div className="composer-inner">
        {sendError ? (
          <div className="banner error" role="alert"><span>Send failed: {sendError} (draft preserved)</span></div>
        ) : null}
        {sendDisabledReason ? (
          <p className="composer-reason" role="status">{sendDisabledReason}</p>
        ) : null}
        <div className="composer">
          <textarea
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={handleKey}
            placeholder="What would you like to explore next?"
            aria-label="Message the agent"
            disabled={!canSend && !streaming}
            rows={3}
          />
          <div className="bottom">
            <span className="composer-meta">Local · no cloud sync</span>
            <div className="row">
              {streaming ? (
                <button className="btn" onClick={onAbort}>Stop</button>
              ) : (
                <button
                  className="send"
                  onClick={onSend}
                  disabled={!canSend || sending || draft.trim().length === 0}
                  aria-label="Send message"
                >
                  {sending ? '…' : '↑'}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="composer-footnote">
          <span>You approve new compute.</span>
          <span className="enter-hint"><kbd>↵</kbd> send · Shift+↵ newline</span>
        </div>
      </div>
    </div>
  );
}
