export interface PullRequestInput { title: string; body: string; head: string; base: string }
export interface PullRequest { number: number; url: string; head: string; base: string; state: string }
export interface CheckRunSummary { name: string; status: string; conclusion: string | null; url?: string }
export interface CiResult { ref: string; status: 'success' | 'failure' | 'pending' | 'cancelled' | 'timed_out'; checks: CheckRunSummary[] }

export interface GitHubClientOptions { token: string; owner: string; repo: string; fetcher?: typeof fetch }

export class GitHubRepositoryClient {
  private readonly fetcher: typeof fetch;
  public constructor(private readonly options: GitHubClientOptions) { this.fetcher = options.fetcher ?? fetch; }

  public async createPullRequest(input: PullRequestInput): Promise<PullRequest> {
    const response = await this.fetcher(`https://api.github.com/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}/pulls`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`GitHub pull request creation failed with status ${response.status}.`);
    const body = await response.json() as { number?: unknown; html_url?: unknown; head?: { ref?: unknown }; base?: { ref?: unknown }; state?: unknown };
    if (typeof body.number !== 'number' || typeof body.html_url !== 'string') throw new Error('GitHub response did not contain pull request metadata.');
    return { number: body.number, url: body.html_url, head: typeof body.head?.ref === 'string' ? body.head.ref : input.head, base: typeof body.base?.ref === 'string' ? body.base.ref : input.base, state: typeof body.state === 'string' ? body.state : 'open' };
  }

  public async listOpenPullRequests(input: { head: string; base: string }): Promise<PullRequest[]> {
    const response = await this.fetcher(`https://api.github.com/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}/pulls?state=open&head=${encodeURIComponent(`${this.options.owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}`, {
      headers: this.headers(),
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
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`GitHub check-run lookup failed with status ${response.status}.`);
    const body = await response.json() as { check_runs?: Array<{ name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown }> };
    return (body.check_runs ?? []).flatMap((candidate) => typeof candidate.name === 'string' && typeof candidate.status === 'string'
      ? [{ name: candidate.name, status: candidate.status, conclusion: typeof candidate.conclusion === 'string' ? candidate.conclusion : null, ...(typeof candidate.html_url === 'string' ? { url: candidate.html_url } : {}) }]
      : []);
  }

  public async waitForChecks(input: { ref: string; required?: string[]; timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<CiResult> {
    const deadline = Date.now() + Math.max(1, input.timeoutMs ?? 120_000);
    const required = input.required ?? [];
    while (true) {
      input.signal?.throwIfAborted();
      const checks = await this.getCheckRuns(input.ref);
      const selected = required.length === 0 ? checks : checks.filter((check) => required.includes(check.name));
      const missingRequired = required.some((name) => !selected.some((check) => check.name === name));
      const failed = selected.some((check) => check.status === 'completed' && !['success', 'skipped', 'neutral'].includes(check.conclusion ?? ''));
      const complete = !missingRequired && selected.length > 0 && selected.every((check) => check.status === 'completed');
      if (failed) return { ref: input.ref, status: 'failure', checks };
      if (complete) return { ref: input.ref, status: 'success', checks };
      if (Date.now() >= deadline) return { ref: input.ref, status: 'timed_out', checks };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(Math.max(10, input.intervalMs ?? 2_000), Math.max(1, deadline - Date.now())));
        input.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(input.signal?.reason); }, { once: true });
      });
    }
  }

  private headers(): Record<string, string> {
    return { accept: 'application/vnd.github+json', authorization: `Bearer ${this.options.token}`, 'x-github-api-version': '2022-11-28' };
  }
}
