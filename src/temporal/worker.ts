import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { NativeConnection, Worker } from '@temporalio/worker';

import * as activities from './activities.js';
import { configureTemporalObservabilitySink } from './activities.js';
import { PlatformTemporalObservabilitySink } from './observability.js';
import { JsonStore } from '../storage/json-store.js';
import { PostgresStore } from '../storage/postgres-store.js';
import type { PlatformStore } from '../storage/store.js';

const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'agentic-workflows';
const databaseUrl = process.env.DATABASE_URL;
const dataFile = process.env.DATA_FILE ?? path.join(process.cwd(), '.data', 'state.json');
const store: PlatformStore = databaseUrl === undefined ? new JsonStore(dataFile) : new PostgresStore(databaseUrl);
configureTemporalObservabilitySink(new PlatformTemporalObservabilitySink(store));
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
  await store.close?.();
}
