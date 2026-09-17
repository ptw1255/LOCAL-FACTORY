import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NativeConnection, Worker } from '@temporalio/worker';

import * as activities from './activities.js';
import { configureTemporalObservabilitySink } from './activities.js';
import { configureTemporalGitHubRepository, configureTemporalModelProviders, type TemporalModelClient } from './activities.js';
import { PlatformTemporalObservabilitySink } from './observability.js';
import { JsonStore } from '../storage/json-store.js';
import { PostgresStore } from '../storage/postgres-store.js';
import type { PlatformStore } from '../storage/store.js';
import { RepositoryWorkspace } from '../repository/workspace.js';
import { GitHubRepositoryClient } from '../repository/github.js';
import { VaultSecretBroker } from '../connections/vault-secret-broker.js';
import { HttpOllamaClient } from '../runtime/ollama.js';
import { OpenAISDKClient } from '../runtime/openai-sdk.js';
import { OpenAICompatibleClient } from '../runtime/openai-compatible.js';
import { AnthropicClient } from '../runtime/anthropic.js';
import { GeminiClient } from '../runtime/gemini.js';
import { temporalConnectionSettings, temporalTaskQueues } from './config.js';

const temporalSettings = temporalConnectionSettings();
const address = temporalSettings.address;
const namespace = temporalSettings.namespace;
const taskQueues = temporalTaskQueues();
const databaseUrl = process.env.DATABASE_URL;
const dataFile = process.env.DATA_FILE ?? path.join(process.cwd(), '.data', 'state.json');
const store: PlatformStore = databaseUrl === undefined ? new JsonStore(dataFile) : new PostgresStore(databaseUrl);
configureTemporalObservabilitySink(new PlatformTemporalObservabilitySink(store));
const configuredRepositoryWorkspace = process.env.REPOSITORY_WORKSPACE?.trim();
const repositoryWorkspace = configuredRepositoryWorkspace === undefined || configuredRepositoryWorkspace === ''
  ? undefined
  : await RepositoryWorkspace.open(configuredRepositoryWorkspace);
const configuredRunRoot = process.env.TEMPORAL_REPOSITORY_RUN_ROOT?.trim() || undefined;
activities.configureTemporalRepositoryWorkspace(repositoryWorkspace, configuredRunRoot === undefined ? {} : { runRoot: configuredRunRoot });
const configuredGithubOwner = process.env.GITHUB_REPOSITORY_OWNER?.trim();
const configuredGithubRepo = process.env.GITHUB_REPOSITORY_NAME?.trim();
const configuredGithubToken = process.env.GITHUB_TOKEN?.trim();
const configuredGithubSecretRef = process.env.GITHUB_SECRET_REF?.trim();
const vaultAddress = process.env.VAULT_ADDR?.trim();
const vaultToken = process.env.VAULT_TOKEN?.trim();
const secretBroker = vaultAddress !== undefined && vaultToken !== undefined
  ? new VaultSecretBroker({ address: vaultAddress, token: vaultToken })
  : undefined;
const githubRepository = configuredGithubOwner !== undefined && configuredGithubOwner !== '' && configuredGithubRepo !== undefined && configuredGithubRepo !== '' && ((configuredGithubToken !== undefined && configuredGithubToken !== '') || (configuredGithubSecretRef !== undefined && configuredGithubSecretRef !== '' && secretBroker !== undefined))
  ? new GitHubRepositoryClient({ owner: configuredGithubOwner, repo: configuredGithubRepo, ...(configuredGithubToken === undefined || configuredGithubToken === '' ? {} : { token: configuredGithubToken }), ...(configuredGithubSecretRef === undefined || configuredGithubSecretRef === '' || secretBroker === undefined ? {} : { secretRef: configuredGithubSecretRef, secretBroker }) })
  : undefined;
activities.configureTemporalGitHubRepository(githubRepository);
const ollama = new HttpOllamaClient();
const providers = new Map<string, TemporalModelClient>([
  ['openai', new OpenAISDKClient({ secretBroker })],
  ['anthropic', new AnthropicClient({ secretBroker })],
  ['gemini', new GeminiClient({ secretBroker })],
  ['openai-compatible', new OpenAICompatibleClient({ secretBroker })],
  ['lmstudio', new OpenAICompatibleClient({ provider: 'lmstudio', secretBroker })],
  ['lm-studio', new OpenAICompatibleClient({ provider: 'lm-studio', secretBroker })],
  ['vllm', new OpenAICompatibleClient({ provider: 'vllm', secretBroker })],
  ['localai', new OpenAICompatibleClient({ provider: 'localai', secretBroker })],
]);
configureTemporalModelProviders({ clients: providers, ollama });
const connection = await NativeConnection.connect({ address, ...(temporalSettings.tls === undefined ? {} : { tls: temporalSettings.tls }), ...(temporalSettings.apiKey === undefined ? {} : { apiKey: temporalSettings.apiKey }) });
const compiledWorkflowsPath = new URL('./workflows.js', import.meta.url);
const sourceWorkflowsPath = new URL('./workflows.ts', import.meta.url);
const workers = await Promise.all(taskQueues.map((taskQueue) => Worker.create({
  connection,
  namespace,
  taskQueue,
  // The production image contains only compiled server output, while local
  // `tsx` execution uses the TypeScript source tree.
  workflowsPath: fileURLToPath(existsSync(fileURLToPath(compiledWorkflowsPath)) ? compiledWorkflowsPath : sourceWorkflowsPath),
  activities,
})));

try {
  await Promise.all(workers.map((worker) => worker.run()));
} finally {
  for (const worker of workers) worker.shutdown();
  configureTemporalObservabilitySink(undefined);
  activities.configureTemporalRepositoryWorkspace(undefined);
  configureTemporalGitHubRepository(undefined);
  configureTemporalModelProviders();
  await store.close?.();
}
