import type { ReactNode } from 'react';

import { Icon, type IconName } from './icons';
import type { ViewId } from './types';

export type WorkspaceNavigationItem = {
  id: Exclude<ViewId, 'runs'>;
  label: string;
  icon: IconName;
  beta?: boolean;
};

export interface WorkspaceShellProps {
  view: ViewId;
  navigation: readonly WorkspaceNavigationItem[];
  mobileNavOpen: boolean;
  projectSwitcher: ReactNode;
  onNavigate: (view: Exclude<ViewId, 'runs'>) => void;
  onCloseMobileNavigation: () => void;
  onOpenMobileNavigation: () => void;
  children: ReactNode;
}

/** Stable application frame shared by authoring and operational views. */
export function WorkspaceShell({
  view,
  navigation,
  mobileNavOpen,
  projectSwitcher,
  onNavigate,
  onCloseMobileNavigation,
  onOpenMobileNavigation,
  children,
}: WorkspaceShellProps) {
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark"><Icon name="spark" size={22} /></span>
          <div>
            <strong>Agentic</strong>
            <span>Workflow Factory</span>
          </div>
        </div>
        {projectSwitcher}
        <nav aria-label="Primary navigation">
          <span className="nav-section-label">Build &amp; operate</span>
          {navigation.map((item) => (
            <button
              aria-current={view === item.id ? 'page' : undefined}
              className={view === item.id ? 'active' : ''}
              key={item.id}
              onClick={() => onNavigate(item.id)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.beta === true ? <span className="nav-beta">AI</span> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="system-dot" />
          <div>
            <strong>Factory online</strong>
            <span>Local durable engine</span>
          </div>
        </div>
      </aside>
      {mobileNavOpen ? (
        <button aria-label="Close navigation" className="nav-scrim" onClick={onCloseMobileNavigation} type="button" />
      ) : null}
      <main className="main-content">
        <div className="mobile-bar">
          <button aria-label="Open navigation" className="icon-button" onClick={onOpenMobileNavigation} type="button">
            <Icon name="menu" />
          </button>
          <div className="mobile-brand"><Icon name="spark" /> Workflow Factory</div>
          <span className="system-dot" />
        </div>
        {children}
      </main>
    </div>
  );
}
