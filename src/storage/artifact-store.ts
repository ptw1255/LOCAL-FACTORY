import { createHash } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ArtifactReference {
  id: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  runId?: string;
  tenantId?: string;
  projectId?: string;
}

export interface ArtifactPutInput {
  kind: string;
  content: string | Uint8Array;
  contentType: string;
  runId?: string;
  tenantId?: string;
  projectId?: string;
}

export interface ArtifactStore {
  put(input: ArtifactPutInput): Promise<ArtifactReference>;
  get(id: string): Promise<{ reference: ArtifactReference; content: Uint8Array }>;
  prune(before: string): Promise<number>;
  close?(): Promise<void>;
}

interface ArtifactMetadata {
  reference: ArtifactReference;
}

const artifactIdPattern = /^artifact:sha256:[a-f0-9]{64}$/;

/** Content-addressed filesystem storage for local development and Docker volumes. */
export class FileArtifactStore implements ArtifactStore {
  public constructor(private readonly root: string) {}

  public async put(input: ArtifactPutInput): Promise<ArtifactReference> {
    const content = typeof input.content === 'string' ? new TextEncoder().encode(input.content) : input.content;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const id = `artifact:sha256:${sha256}`;
    const reference: ArtifactReference = {
      id,
      kind: input.kind,
      contentType: input.contentType,
      sizeBytes: content.byteLength,
      sha256,
      createdAt: new Date().toISOString(),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    };
    const dataPath = this.dataPath(id);
    const metadataPath = this.metadataPath(id);
    await mkdir(this.root, { recursive: true });
    try {
      await stat(dataPath);
      return (JSON.parse(await readFile(metadataPath, 'utf8')) as ArtifactMetadata).reference;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporaryBase = path.join(this.root, `.${sha256}.${process.pid}.${Date.now()}`);
    await writeFile(`${temporaryBase}.data`, content);
    await writeFile(`${temporaryBase}.meta`, JSON.stringify({ reference } satisfies ArtifactMetadata));
    try {
      await link(`${temporaryBase}.data`, dataPath);
      await link(`${temporaryBase}.meta`, metadataPath);
      await rm(`${temporaryBase}.data`, { force: true });
      await rm(`${temporaryBase}.meta`, { force: true });
    } catch (error) {
      // Concurrent puts for the same content are safe; retain the first writer.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await rm(`${temporaryBase}.data`, { force: true });
        await rm(`${temporaryBase}.meta`, { force: true });
        throw error;
      }
      await rm(`${temporaryBase}.data`, { force: true });
      await rm(`${temporaryBase}.meta`, { force: true });
      return (JSON.parse(await readFile(metadataPath, 'utf8')) as ArtifactMetadata).reference;
    }
    return reference;
  }

  public async get(id: string): Promise<{ reference: ArtifactReference; content: Uint8Array }> {
    if (!artifactIdPattern.test(id)) throw new Error('Artifact reference is invalid.');
    const reference = (JSON.parse(await readFile(this.metadataPath(id), 'utf8')) as ArtifactMetadata).reference;
    const content = new Uint8Array(await readFile(this.dataPath(id)));
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== reference.sha256 || actual !== id.slice('artifact:sha256:'.length)) throw new Error('Artifact content hash does not match its reference.');
    return { reference, content };
  }

  public async prune(before: string): Promise<number> {
    let deleted = 0;
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    for (const entry of entries.filter((value) => value.endsWith('.meta'))) {
      const metadataPath = path.join(this.root, entry);
      let reference: ArtifactReference;
      try {
        reference = (JSON.parse(await readFile(metadataPath, 'utf8')) as ArtifactMetadata).reference;
      } catch {
        continue;
      }
      if (reference.createdAt >= before) continue;
      const id = reference.id;
      await Promise.all([
        unlink(metadataPath).catch(() => undefined),
        unlink(this.dataPath(id)).catch(() => undefined),
      ]);
      deleted += 1;
    }
    return deleted;
  }

  private dataPath(id: string): string {
    return path.join(this.root, `${this.fileName(id)}.data`);
  }

  private metadataPath(id: string): string {
    return path.join(this.root, `${this.fileName(id)}.meta`);
  }

  private fileName(id: string): string {
    if (!artifactIdPattern.test(id)) throw new Error('Artifact reference is invalid.');
    return id.slice('artifact:sha256:'.length);
  }
}
