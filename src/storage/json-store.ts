import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createSeedState } from '../domain/seed.js';
import type { EvidenceQuery, OperationEvidence, PlatformState, RunEvent } from '../domain/types.js';
import { normalizePlatformState, type EventListOptions, type PlatformStore, type StateMutation } from './store.js';

export class JsonStore implements PlatformStore {
  private state: PlatformState | undefined;
  private loadPromise: Promise<PlatformState> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly lockPath: string;

  public constructor(private readonly filePath: string) {
    this.lockPath = `${filePath}.lock`;
  }

  public async read<T>(select: (state: PlatformState) => T): Promise<T> {
    const operation = this.queue.then(async () => this.withFileLock(async () => select(await this.loadLatest())));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return structuredClone(await operation);
  }

  public async mutate<T>(mutation: StateMutation<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      return this.withFileLock(async () => {
        const draft = structuredClone(await this.loadLatest());
        const result = await mutation(draft);
        await this.persist(draft);
        this.state = draft;
        return result;
      });
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return structuredClone(await operation);
  }

  public async mutateAndAppendEvent<T>(mutation: StateMutation<{ value: T; event?: RunEvent }>): Promise<{ value: T; eventAppended: boolean }> {
    const operation = this.queue.then(async () => {
      return this.withFileLock(async () => {
        const draft = structuredClone(await this.loadLatest());
        const result = await mutation(draft);
        if (result.event !== undefined && !draft.events.some((candidate) => candidate.id === result.event?.id)) draft.events.push(result.event);
        await this.persist(draft);
        this.state = draft;
        return { value: result.value, eventAppended: result.event !== undefined };
      });
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return structuredClone(await operation);
  }

  public async appendEvent(event: RunEvent): Promise<void> {
    await this.mutate((state) => {
      if (!state.events.some((candidate) => candidate.id === event.id)) state.events.push(event);
    });
  }

  public async appendEvidence(evidence: OperationEvidence): Promise<void> {
    await this.mutate((state) => {
      if (!state.evidence.some((candidate) => candidate.id === evidence.id)) state.evidence.push(evidence);
    });
  }

  public listEvidence(query?: string | EvidenceQuery): Promise<OperationEvidence[]> {
    const filter: EvidenceQuery = typeof query === 'string' ? { runId: query } : query ?? {};
    return this.read((state) => state.evidence
      .filter((entry) => (filter.runId === undefined || entry.runId === filter.runId)
        && (filter.deploymentId === undefined || entry.deploymentId === filter.deploymentId)
        && (filter.tenantId === undefined || entry.tenantId === filter.tenantId)
        && (filter.projectId === undefined || entry.projectId === filter.projectId)
        && (filter.unitId === undefined || entry.unitId === filter.unitId)
        && (filter.operation === undefined || entry.operation === filter.operation)
        && (filter.status === undefined || entry.status === filter.status)
        && (filter.from === undefined || entry.occurredAt >= filter.from)
        && (filter.to === undefined || entry.occurredAt <= filter.to)
        && (filter.repository === undefined || entry.metadata?.['repository.name'] === filter.repository)
        && (filter.revision === undefined || entry.metadata?.['repository.revision'] === filter.revision || entry.metadata?.['repository.base_revision'] === filter.revision)
        && (filter.commit === undefined || entry.metadata?.['repository.revision'] === filter.commit)
        && (filter.pullRequest === undefined || String(entry.metadata?.['pull_request.number'] ?? '') === filter.pullRequest))
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)));
  }

  public async pruneEvents(before: string): Promise<number> {
    return this.mutate((state) => {
      const originalLength = state.events.length;
      state.events = state.events.filter((event) => event.timestamp >= before);
      return originalLength - state.events.length;
    });
  }

  public async pruneEvidence(before: string): Promise<number> {
    return this.mutate((state) => {
      const originalLength = state.evidence.length;
      state.evidence = state.evidence.filter((entry) => entry.occurredAt >= before);
      return originalLength - state.evidence.length;
    });
  }

  public listEvents(runId?: string, options: EventListOptions = {}): Promise<RunEvent[]> {
    return this.read((state) =>
      state.events
        .filter((event) => runId === undefined || event.runId === runId)
        .filter((event) => options.before === undefined || event.timestamp < options.before)
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    ).then((events) => options.limit === undefined ? events : events.slice(Math.max(0, events.length - Math.max(1, options.limit))));
  }

  private async load(): Promise<PlatformState> {
    if (this.state !== undefined) {
      return this.state;
    }
    this.loadPromise ??= this.loadInitialState();
    this.state = await this.loadPromise;
    return this.state;
  }

  /** Reload the state document so a mutation observes writes from other processes. */
  private async loadLatest(): Promise<PlatformState> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(contents) as PlatformState;
      const unscopedEventIds = new Set((parsed.events ?? [])
        .filter((event) => event.tenantId === undefined && event.projectId === undefined)
        .map((event) => event.id));
      const state = normalizePlatformState(parsed);
      // Preserve the shape of events explicitly appended without scope
      // metadata; this matches the existing append contract while still
      // applying migrations to the rest of the state document.
      for (const event of state.events) {
        if (!unscopedEventIds.has(event.id)) continue;
        delete event.tenantId;
        delete event.projectId;
      }
      this.state = state;
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.load();
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    let handle;
    while (handle === undefined) {
      try {
        handle = await open(this.lockPath, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const ageMs = Date.now() - (await stat(this.lockPath)).mtimeMs;
          if (ageMs > 120_000) {
            await unlink(this.lockPath);
            continue;
          }
        } catch (staleCheckError) {
          if ((staleCheckError as NodeJS.ErrnoException).code !== 'ENOENT') throw staleCheckError;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(this.lockPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  private async loadInitialState(): Promise<PlatformState> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      const state = JSON.parse(contents) as PlatformState;
      return normalizePlatformState(state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const seed = createSeedState();
      await this.persist(seed);
      return seed;
    }
  }

  private async persist(state: PlatformState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}
