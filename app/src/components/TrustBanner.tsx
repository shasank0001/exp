interface TrustBannerProps {
  projectPath: string;
  provider?: string;
  saving: boolean;
  saveError: string | null;
  onTrust: () => void;
  onDefer: () => void;
}

/**
 * Disclosure shown before the first prompt in an untrusted project.
 * Both actions are wired to setTrust: Trust stores true, Not now stores false.
 */
export default function TrustBanner(props: TrustBannerProps) {
  const { projectPath, provider, saving, saveError, onTrust, onDefer } = props;

  return (
    <section className="banner trust" aria-label="Project trust">
      <strong>Trust this project before sending?</strong>
      <p>
        Prompts and project content may be sent to{' '}
        {provider ? <span className="mono">{provider}</span> : 'the configured model provider'}.
        Files stay local — the agent runs with this folder as its working directory.
        Approval review UI is still coming; automatic declines will appear as messages.
      </p>
      <p className="muted small wrap">{projectPath}</p>
      {saveError ? <p role="alert">Couldn’t save trust choice: {saveError} (sending stays blocked)</p> : null}
      <div className="trust-actions">
        <button className="btn" onClick={onTrust} disabled={saving}>
          {saving ? 'Saving…' : 'Trust'}
        </button>
        <button className="btn quiet" onClick={onDefer} disabled={saving}>
          Not now
        </button>
      </div>
    </section>
  );
}

export function TrustReminder({ onTrust, saving }: { onTrust: () => void; saving: boolean }) {
  return (
    <div className="banner trust reminder" role="status">
      <span>This project isn’t trusted yet — sending is blocked.</span>
      <button className="btn" onClick={onTrust} disabled={saving}>
        {saving ? 'Saving…' : 'Trust'}
      </button>
    </div>
  );
}
