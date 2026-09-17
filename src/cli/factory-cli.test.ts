import { describe, expect, it } from 'vitest';

import { browserOpenCommand, composeArguments, factoryBanner, parseFactoryArgs } from '../../scripts/factory-cli.js';
import { portalItemCount, renderTerminalPortal, renderTerminalSnapshot } from '../../scripts/factory-terminal.js';

describe('FACTORY CLI argument handling', () => {
  it('defaults to launching the local dashboard', () => {
    expect(parseFactoryArgs([])).toMatchObject({ command: 'launch', profiles: [], help: false });
    expect(parseFactoryArgs(['--help'])).toMatchObject({ command: 'help', help: true });
    expect(parseFactoryArgs(['--all'])).toMatchObject({ command: 'launch', profiles: ['temporal', 'observability', 'ollama'] });
    expect(parseFactoryArgs(['--no-web'])).toMatchObject({ command: 'launch', web: false });
  });

  it('supports lifecycle aliases and optional compose profiles', () => {
    expect(parseFactoryArgs(['start', '--all'])).toMatchObject({
      command: 'up',
      profiles: ['temporal', 'observability', 'ollama'],
    });
    expect(parseFactoryArgs(['dashboard'])).toMatchObject({ command: 'dashboard' });
    expect(parseFactoryArgs(['dashboards'])).toMatchObject({ command: 'dashboard' });
    expect(parseFactoryArgs(['logs', 'app'])).toMatchObject({ command: 'logs', service: 'app' });
    expect(parseFactoryArgs(['observe', 'run-1', '--follow', '--interval', '500'])).toMatchObject({ command: 'observe', runId: 'run-1', follow: true, intervalMs: 500 });
    expect(parseFactoryArgs(['deny', 'run-1', 'Needs review'])).toMatchObject({ command: 'deny', runId: 'run-1', reason: 'Needs review' });
  });

  it('parses declarative resource commands', () => {
    expect(parseFactoryArgs(['run', 'examples/code-review-loop.yaml', 'review'])).toMatchObject({
      command: 'run',
      resourcePath: 'examples/code-review-loop.yaml',
      workflowId: 'review',
    });
  });

  it('builds deterministic docker compose arguments', () => {
    expect(composeArguments('up', ['ollama'])).toEqual(['--profile', 'ollama', 'up', '-d', '--build']);
    expect(composeArguments('logs', [], 'app')).toEqual(['logs', '--tail', '100', 'app']);
    expect(composeArguments('down', [])).toEqual(['down', '--remove-orphans']);
  });

  it('selects a native browser opener per platform', () => {
    expect(browserOpenCommand('http://localhost:3100', 'darwin')).toEqual({ command: 'open', args: ['http://localhost:3100'] });
    expect(browserOpenCommand('http://localhost:3100', 'linux')).toEqual({ command: 'xdg-open', args: ['http://localhost:3100'] });
  });

  it('renders a terminal snapshot without exposing payloads', () => {
    const output = renderTerminalSnapshot({ runs: [], approvals: [], deployments: [] }, { clear: false });
    expect(output).toContain('terminal control plane');
    expect(output).toContain('RUNS');
    expect(output).toContain('APPROVALS');
    expect(output).toContain('DEPLOYMENTS');
  });

  it('provides a recognizable FACTORY terminal banner', () => {
    const banner = factoryBanner();
    expect(banner).toContain('███████╗');
    expect(banner).toContain('███████╗╚██████╔╝');
    expect(banner.split('\n')).toHaveLength(13);
  });

  it('renders a navigable terminal portal with dashboard choices', () => {
    const snapshot = { runs: [], approvals: [], deployments: [] };
    expect(portalItemCount(snapshot, 'home')).toBe(9);
    expect(portalItemCount(snapshot, 'portals')).toBe(4);
    expect(renderTerminalPortal(snapshot, { page: 'home', cursor: 8 }, { clear: false })).toContain('Portals');
    expect(renderTerminalPortal(snapshot, { page: 'portals', cursor: 0 }, { clear: false })).toContain('Observe');
  });
});
