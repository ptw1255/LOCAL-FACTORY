export interface PullRequestInput { title: string; body: string; head: string; base: string }
export interface PullRequest { number: number; url: string; head: string; base: string; state: string }
export interface CheckRunSummary { name: string; status: string; conclusion: string | null; url?: string; summary?: string }
export interface CiFailure { name: string; conclusion: string | null; url?: string; summary?: string }
export interface CiResult { ref: string; status: 'success' | 'failure' | 'pending' | 'cancelled' | 'timed_out'; checks: CheckRunSummary[]; required: string[]; failures: CiFailure[] }
export interface CiPollUpdate { checks: CheckRunSummary[]; status: 'pending' | 'success' | 'failure' | 'timed_out'; }
export class GitHubApiError extends Error {
  public readonly code = 'GITHUB_API_ERROR';
  public constructor(message: string, public readonly status: number, public readonly retryAfterMs?: number) { super(message); this.name = 'GitHubApiError'; }
}
export class RepositoryCiError extends Error {
  public readonly code = 'REPOSITORY_CI_FAILED';
  public constructor(message: string, public readonly result: CiResult) { super(message); this.name = 'RepositoryCiError'; }
}

export interface GitHubClientOptions { token?: string; secretRef?: string; secretBroker?: SecretBroker; owner: string; repo: string; fetcher?: typeof fetch }

export class GitHubRepositoryClient {
  private readonly fetcher: typeof fetch;
  public constructor(private readonly options: GitHubClientOptions) { this.fetcher = options.fetcher ?? fetch; }

  public async createPullRequest(input: PullRequestInput): Promise<PullRequest> {
    const response = await this.fetcher(`https://api.github.com/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}/pulls`, {
      method: 'POST',
      headers: { ...(await this.headers()), 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`GitHub pull request creation failed with status ${response.status}.`);
    const body = await response.json() as { number?: unknown; html_url?: unknown; head?: { ref?: unknown }; base?: { ref?: unknown }; state?: unknown };
    if (typeof body.number !== 'number' || typeof body.html_url !== 'string') throw new Error('GitHub response did not contain pull request metadata.');
    return { number: body.number, url: body.html_url, head: typeof body.head?.ref === 'string' ? body.head.ref : input.head, base: typeof body.base?.ref === 'string' ? body.base.ref : input.base, state: typeof body.state === 'string' ? body.state : 'open' };
  }

  public async listOpenPullRequests(input: { head: string; base: string }): Promise<PullRequest[]> {
    const response = await this.fetcher(`https://api.github.com/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}/pulls?state=open&head=${encodeURIComponent(`${this.options.owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}`, {
      headers: await this.headers(),
    });
    if (!response.ok) throw new Error(`GitHub pull request lookup failed with status ${response.status}.`);
    const body = await response.json() as Array<{ number?: unknown; html_url?: unknown; head?: { ref?: unknown }; base?: { ref?: unknown }; state?: unknown }>;
    return body.flatMap((candidate) => typeof candidate.number === 'number' && typeof candidate.html_url === 'string'
      ? [{ number: candidate.number, url: candidate.html_url, head: typeof candidate.head?.ref === 'string' ? candidate.head.ref : input.head, base: typeof candidate.base?.ref === 'string' ? candidate.base.ref : input.base, state: typeof candidate.state === 'string' ? candidate.state : 'open' }]
      : []);
  }

  public async createOrGetPullRequest(input: PullRequestInput): Promise<PullRequest> {
    const existing = await this.listOpenPullRequests(input);
    return existing[0] ?? this.createPullRequest(input);
  }

  public async getCheckRuns(ref: string): Promise<CheckRunSummary[]> {
    const response = await this.fetcher(`https://api.github.com/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}/commits/${encodeURIComponent(ref)}/check-runs`, {
      headers: await this.headers(),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter === null ? undefined : Math.max(0, Number(retryAfter) * 1_000);
      throw new GitHubApiError(`GitHub check-run lookup failed with status ${response.status}.`, response.status, Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
    }
    const body = await response.json() as { check_runs?: Array<{ name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; output?: { text?: unknown } }> };
    return (body.check_runs ?? []).flatMap((candidate) => typeof candidate.name === 'string' && typeof candidate.status === 'string'
      ? [{ name: candidate.name, status: candidate.status, conclusion: typeof candidate.conclusion === 'string' ? candidate.conclusion : null, ...(typeof candidate.html_url === 'string' ? { url: candidate.html_url } : {}), ...(typeof candidate.output?.text === 'string' && candidate.output.text !== '' ? { summary: candidate.output.text.slice(0, 2_000) } : {}) }]
      : []);
  }

  public async waitForChecks(input: { ref: string; required?: string[]; timeoutMs?: number; intervalMs?: number; signal?: AbortSignal; onPoll?: (update: CiPollUpdate) => Promise<void> | void }): Promise<CiResult> {
    const deadline = Date.now() + Math.max(1, input.timeoutMs ?? 120_000);
    const required = input.required ?? [];
    let rateLimitAttempts = 0;
    while (true) {
      input.signal?.throwIfAborted();
      let checks: CheckRunSummary[];
      try {
        checks = await this.getCheckRuns(input.ref);
        rateLimitAttempts = 0;
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.status !== 429 || rateLimitAttempts >= 3) throw error;
        rateLimitAttempts += 1;
        const waitMs = Math.min(error.retryAfterMs ?? 1_000, Math.max(1, deadline - Date.now()));
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, waitMs);
          input.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(input.signal?.reason); }, { once: true });
        });
        continue;
      }
      const selected = required.length === 0 ? checks : checks.filter((check) => required.includes(check.name));
      const missingRequired = required.some((name) => !selected.some((check) => check.name === name));
      const failed = selected.some((check) => check.status === 'completed' && !['success', 'skipped', 'neutral'].includes(check.conclusion ?? ''));
      const complete = !missingRequired && selected.length > 0 && selected.every((check) => check.status === 'completed');
      const failures = selected.filter((check) => check.status === 'completed' && !['success', 'skipped', 'neutral'].includes(check.conclusion ?? '')).map((check) => ({ name: check.name, conclusion: check.conclusion, ...(check.url === undefined ? {} : { url: check.url }), ...(check.summary === undefined ? {} : { summary: check.summary }) }));
      if (failed) { await input.onPoll?.({ checks, status: 'failure' }); return { ref: input.ref, status: 'failure', checks, required, failures }; }
      if (complete) { await input.onPoll?.({ checks, status: 'success' }); return { ref: input.ref, status: 'success', checks, required, failures }; }
      if (Date.now() >= deadline) { await input.onPoll?.({ checks, status: 'timed_out' }); return { ref: input.ref, status: 'timed_out', checks, required, failures }; }
      await input.onPoll?.({ checks, status: 'pending' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(Math.max(10, input.intervalMs ?? 2_000), Math.max(1, deadline - Date.now())));
        input.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(input.signal?.reason); }, { once: true });
      });
    }
  }

  private async headers(): Promise<Record<string, string>> {
    const token = this.options.secretRef === undefined
      ? this.options.token
      : this.options.secretBroker === undefined
        ? undefined
        : await this.options.secretBroker.get(this.options.secretRef);
    if (token === undefined || token.trim() === '') throw new Error('GitHub credentials are not configured.');
    return { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
  }
}
import type { SecretBroker } from '../connections/secret-broker.js';
