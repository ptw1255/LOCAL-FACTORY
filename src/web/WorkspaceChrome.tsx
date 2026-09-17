import { useState, type FormEvent, type ReactNode } from 'react';

import { Icon, type IconName } from './icons';
import type { ProjectRecord } from './types';

export function ProjectSwitcher({
  projects,
  currentProjectId,
  onSelect,
  onCreate,
}: {
  projects: ProjectRecord[];
  currentProjectId: string;
  onSelect: (projectId: string) => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length === 0) return;
    setError(null);
    try {
      await onCreate(name.trim(), description.trim());
      setName('');
      setDescription('');
      setCreating(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create loop.');
    }
  }

  return (
    <section className="project-switcher" aria-label="Projects">
      <span className="nav-section-label">Current loop</span>
      <select aria-label="Select project loop" onChange={(event) => onSelect(event.target.value)} value={currentProjectId}>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <button className="project-create-button" onClick={() => setCreating((value) => !value)} type="button">
        <Icon name={creating ? 'close' : 'plus'} size={13} /> {creating ? 'Close' : 'New loop'}
      </button>
      {creating ? (
        <form className="project-create-form" onSubmit={(event) => void submit(event)}>
          <input aria-label="Loop name" autoFocus onChange={(event) => setName(event.target.value)} placeholder="Loop name" required value={name} />
          <input aria-label="Loop description" onChange={(event) => setDescription(event.target.value)} placeholder="What should it do?" value={description} />
          {error === null ? null : <small className="field-error">{error}</small>}
          <button className="button primary wide" type="submit">Create loop</button>
        </form>
      ) : null}
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: IconName;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-panel empty-state">
      <span className="empty-icon"><Icon name={icon} size={26} /></span>
      <strong>{title}</strong>
      <span>{message}</span>
      {action}
    </div>
  );
}

export function AppHeader({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {children === undefined ? null : <div className="header-actions">{children}</div>}
    </header>
  );
}
