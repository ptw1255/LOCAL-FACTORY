import { Icon } from './icons';

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status.toLowerCase()}`}>{status}</span>;
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state-panel" role="status">
      <span className="spinner" />
      <strong>{label}</strong>
      <span>Syncing the latest data from the factory.</span>
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="state-panel error-state" role="alert">
      <Icon name="warning" size={28} />
      <strong>We couldn’t load this view</strong>
      <span>{message}</span>
      <button className="button secondary" onClick={retry} type="button">
        <Icon name="refresh" /> Try again
      </button>
    </div>
  );
}
