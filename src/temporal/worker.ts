import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { NativeConnection, Worker } from '@temporalio/worker';

import * as activities from './activities.js';
import { configureTemporalObservabilitySink } from './activities.js';
import { PlatformTemporalObservabilitySink } from './observability.js';
import { JsonStore } from '../storage/json-store.js';
import { PostgresStore } from '../storage/postgres-store.js';
import type { PlatformStore } from '../storage/store.js';
import { RepositoryWorkspace } from '../repository/workspace.js';

const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const configuredTaskQueue = process.env.TEMPORAL_TASK_QUEUE;
const taskQueue = configuredTaskQueue ?? `${process.env.TEMPORAL_TASK_QUEUE_PREFIX ?? 'agentic-workflows'}-v${process.env.TEMPORAL_WORKFLOW_VERSION ?? '1'}`;
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
const connection = await NativeConnection.connect({ address });
const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
  activities,
});

try {
  await worker.run();
} finally {
  configureTemporalObservabilitySink(undefined);
  activities.configureTemporalRepositoryWorkspace(undefined);
  await store.close?.();
}
