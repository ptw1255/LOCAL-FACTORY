import { describe, expect, it, vi } from 'vitest';
import { GitHubRepositoryClient } from './github.js';

describe('GitHubRepositoryClient', () => {
  it('creates a pull request without exposing the token in the payload', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/example/repo/pull/7', head: { ref: 'feature' }, base: { ref: 'main' }, state: 'open' }), { status: 201, headers: { 'x-github-request-id': 'req-pr-7' } }));
    const result = await new GitHubRepositoryClient({ token: 'secret-token', owner: 'example', repo: 'repo', fetcher }).createPullRequest({ title: 'What', body: 'Why', head: 'feature', base: 'main' });
    expect(result).toMatchObject({ number: 7, head: 'feature', base: 'main', requestId: 'req-pr-7' });
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain('secret-token');
  });

  it('resolves GitHub credentials from the configured secret broker per request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('[]', { status: 200 }));
    const secretBroker = { put: vi.fn(), get: vi.fn().mockResolvedValue('vault-token') };
    await new GitHubRepositoryClient({ secretRef: 'connections/github', secretBroker, owner: 'example', repo: 'repo', fetcher }).listOpenPullRequests({ head: 'feature', base: 'main' });
    expect(secretBroker.get).toHaveBeenCalledWith('connections/github');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer vault-token' }));
  });

  it('polls check runs into a normalized terminal result', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'queued', conclusion: null }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/repo/actions/runs/1' }] }), { status: 200, headers: { 'x-github-request-id': 'req-ci-1' } }));
    const client = new GitHubRepositoryClient({ token: 'secret-token', owner: 'example', repo: 'repo', fetcher });
    const result = await client.waitForChecks({ ref: 'abc123', required: ['test'], intervalMs: 10, timeoutMs: 200 });
    expect(result.status).toBe('success');
    expect(result.required).toEqual(['test']);
    expect(result.failures).toEqual([]);
    expect(result.checks[0]).toMatchObject({ name: 'test', conclusion: 'success' });
    expect(result.requestId).toBe('req-ci-1');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports bounded poll checkpoints before terminal results', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'queued', conclusion: null }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }), { status: 200 }));
    const updates: string[] = [];
    await new GitHubRepositoryClient({ token: 'secret-token', owner: 'example', repo: 'repo', fetcher }).waitForChecks({
      ref: 'abc123',
      required: ['test'],
      intervalMs: 10,
      timeoutMs: 200,
      onPoll: ({ status }) => { updates.push(status); },
    });
    expect(updates).toEqual(['pending', 'success']);
  });

  it('reuses an open pull request during an idempotent retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{ number: 7, html_url: 'https://github.com/example/repo/pull/7', head: { ref: 'feature' }, base: { ref: 'main' }, state: 'open' }]), { status: 200 }));
    const result = await new GitHubRepositoryClient({ token: 'secret-token', owner: 'example', repo: 'repo', fetcher }).createOrGetPullRequest({ title: 'What', body: 'Why', head: 'feature', base: 'main' });
    expect(result.number).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns bounded failure summaries for required checks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ check_runs: [{ name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/example/repo/actions/runs/2', output: { text: 'line 1 failed' } }] }), { status: 200 }));
    const result = await new GitHubRepositoryClient({ token: 'secret-token', owner: 'example', repo: 'repo', fetcher }).waitForChecks({ ref: 'def456', required: ['lint'], intervalMs: 10, timeoutMs: 200 });
    expect(result).toMatchObject({ status: 'failure', required: ['lint'], failures: [{ name: 'lint', conclusion: 'failure', url: 'https://github.com/example/repo/actions/runs/2', summary: 'line 1 failed' }] });
  });

  it('retries rate-limited check polling within the deadline', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }), { status: 200 }));
    const result = await new GitHubRepositoryClient({ token: 'secret-token', owner: 'example', repo: 'repo', fetcher }).waitForChecks({ ref: 'abc123', required: ['test'], intervalMs: 10, timeoutMs: 200 });
    expect(result.status).toBe('success');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('normalizes pull request reviews and merge state without exposing credentials', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'open', merged: false, html_url: 'https://github.com/example/repo/pull/9' }), { status: 200, headers: { 'x-github-request-id': 'req-pr-status' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 1, user: { login: 'reviewer' }, state: 'approved', submitted_at: '2026-01-01T00:00:00Z' },
        { id: 2, user: { login: 'reviewer-2' }, state: 'commented' },
      ]), { status: 200 }));
    const result = await new GitHubRepositoryClient({ token: 'secret-token', owner: 'example', repo: 'repo', fetcher }).getPullRequestStatus(9);
    expect(result).toMatchObject({ number: 9, state: 'open', approvals: 1, changesRequested: 0, url: 'https://github.com/example/repo/pull/9', requestId: 'req-pr-status' });
    expect(result.reviews).toEqual(expect.arrayContaining([expect.objectContaining({ id: 1, state: 'APPROVED', user: 'reviewer' })]));
    expect(fetcher.mock.calls.every(([, request]) => request?.body === undefined)).toBe(true);
  });

  it('polls pull request approval into a bounded terminal status', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'open', merged: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'open', merged: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 3, state: 'APPROVED' }]), { status: 200 }));
    const updates: string[] = [];
    const result = await new GitHubRepositoryClient({ token: 'secret-token', owner: 'example', repo: 'repo', fetcher }).waitForPullRequestStatus({ number: 10, requiredApprovals: 1, timeoutMs: 200, intervalMs: 10, onPoll: ({ status }) => { updates.push(status); } });
    expect(result.status).toBe('approved');
    expect(updates).toEqual(['pending', 'approved']);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
