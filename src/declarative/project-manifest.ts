import { createHash } from 'node:crypto';

import { stringify } from 'yaml';
import { z } from 'zod';

/**
 * The Factory-native Project manifest is the `factory.yaml` Project resource.
 * It is deliberately small: topology remains in resource files while this
 * document declares project identity, source conventions, and context policy.
 */
export const projectManifestContextSchema = z.object({
  /** Explicit AGENTS.md paths. Omit to discover every AGENTS.md deterministically. */
  guides: z.array(z.string().min(1).regex(/(^|\/)AGENTS\.md$/, 'must point to an AGENTS.md file')).max(64).optional(),
}).passthrough();

export const projectManifestSpecSchema = z.object({
  description: z.string().optional(),
  resources: z.array(z.string().min(1)).max(2_000).optional(),
  defaults: z.record(z.string(), z.unknown()).optional(),
  context: projectManifestContextSchema.optional(),
  source: z.object({
    repository: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).optional(),
  }).passthrough().optional(),
}).passthrough();

export type ProjectManifestSpec = z.infer<typeof projectManifestSpecSchema>;

export interface ProjectGuide {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

export function isAgentGuidePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized === 'AGENTS.md' || normalized.endsWith('/AGENTS.md');
}

export function createProjectGuide(filePath: string, content: string): ProjectGuide {
  return {
    path: filePath,
    content,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

export function renderProjectManifest(projectId: string, name: string, description = ''): string {
  return stringify({
    apiVersion: 'factory.agentic/v1',
    kind: 'Project',
    metadata: { id: projectId, version: 1, name },
    // An empty context object keeps AGENTS.md discovery enabled by default;
    // `guides: []` is reserved for projects that explicitly opt out.
    spec: { description, resources: [], context: {} },
  });
}
