import { afterEach, describe, expect, it, vi } from 'vitest';

import { readStudioMode, readStudioTabs, readView } from './ide-state';

function storage(values: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(values));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
    clear: () => { entries.clear(); },
    key: (index) => [...entries.keys()][index] ?? null,
    get length() { return entries.size; },
  } as Storage;
}

function stubWindow(hash: string, local: Storage = storage(), session: Storage = storage()): void {
  vi.stubGlobal('window', {
    location: { hash },
    localStorage: local,
    sessionStorage: session,
  } as unknown as Window);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extracted IDE navigation state', () => {
  it('normalizes legacy Runtime and Workspace routes', () => {
    stubWindow('#/runtime?runId=run-1');
    expect(readView()).toBe('observe');
    stubWindow('#/workspace');
    expect(readView()).toBe('studio');
  });

  it('defaults to Files and restores the active file tab', () => {
    const local = storage({
      'factory.studioMode.project-a': 'tree',
      'factory.studioTabs.project-a': JSON.stringify(['project.yaml', 'agents/reviewer.agent.yaml']),
    });
    const session = storage({ 'factory.studioFile.project-a': 'agents/reviewer.agent.yaml' });
    stubWindow('#/studio', local, session);
    expect(readStudioMode('project-a')).toBe('tree');
    expect(readStudioTabs('project-a')).toEqual(['project.yaml', 'agents/reviewer.agent.yaml']);
    expect(readStudioMode('project-b')).toBe('files');
  });
});
