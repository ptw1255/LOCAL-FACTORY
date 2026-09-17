import { execFileSync, spawnSync } from 'node:child_process';

const enabled = process.env.TEMPORAL_DOCKER_SMOKE === '1';
if (!enabled) {
  console.log('Temporal Docker smoke skipped (set TEMPORAL_DOCKER_SMOKE=1 to enable).');
  process.exit(0);
}

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.log('Temporal Docker smoke skipped (Docker daemon unavailable).');
  process.exit(0);
}

const scopeHeaders = { 'content-type': 'application/json', 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
const compose = (...args) => execFileSync('docker', ['compose', '--profile', 'temporal', ...args], {
  stdio: 'inherit',
  env: { ...process.env, EXECUTION_ENGINE: 'temporal', TEMPORAL_ADDRESS: 'temporal:7233' },
});

async function waitFor(url, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (await predicate(response)) return;
    } catch {
      // Compose services are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${url} failed with HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

const unit = (id) => ({ kind: 'deterministic', version: 1, inputSchema: 'any', outputSchema: 'any', timeoutMs: 60_000, retryAttempts: 1, idempotencyKey: `temporal-smoke:${id}:v1` });

let originalWorkflow;
let smokeFailed = false;
try {
  compose('up', '-d', '--build');
  await waitFor('http://localhost:3100/api/health', async (response) => response.ok && (await response.json()).executionEngine === 'temporal');
  originalWorkflow = await json('http://localhost:3100/api/workflows/workflow-agent-intake', { headers: scopeHeaders });
  const workflow = {
    ...originalWorkflow,
    agents: [],
    trigger: { type: 'manualTrigger' },
    nodes: [
      { id: 'smoke-trigger', type: 'manualTrigger', label: 'Smoke trigger', position: { x: 40, y: 180 }, config: {}, unit: unit('trigger') },
      { id: 'smoke-wait', type: 'wait', label: 'Restart boundary', position: { x: 320, y: 180 }, config: { durationMs: 8_000 }, unit: unit('wait') },
      { id: 'smoke-output', type: 'output', label: 'Smoke output', position: { x: 600, y: 180 }, config: { value: 'temporal-smoke-passed' }, unit: unit('output') },
    ],
    edges: [
      { id: 'smoke-trigger-wait', source: 'smoke-trigger', target: 'smoke-wait' },
      { id: 'smoke-wait-output', source: 'smoke-wait', target: 'smoke-output' },
    ],
  };
  await json('http://localhost:3100/api/workflows/workflow-agent-intake', { method: 'PUT', headers: scopeHeaders, body: JSON.stringify(workflow) });
  const run = await json('http://localhost:3100/api/workflows/workflow-agent-intake/runs', { method: 'POST', headers: scopeHeaders, body: JSON.stringify({ input: { smoke: true } }) });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  compose('restart', 'temporal-worker');
  await waitFor(`http://localhost:3100/api/runs/${encodeURIComponent(run.id)}`, async (response) => {
    if (!response.ok) return false;
    const value = await response.json();
    return ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(value.status);
  });
  const finalRun = await json(`http://localhost:3100/api/runs/${encodeURIComponent(run.id)}`, { headers: scopeHeaders });
  if (finalRun.status !== 'succeeded') throw new Error(`Temporal smoke run ended in ${finalRun.status}: ${finalRun.error ?? 'unknown error'}`);
  const events = await json(`http://localhost:3100/api/events?runId=${encodeURIComponent(run.id)}`, { headers: scopeHeaders });
  const completed = events.items.filter((event) => event.type === 'unit.succeeded').map((event) => event.nodeId);
  for (const nodeId of ['smoke-trigger', 'smoke-wait', 'smoke-output']) if (!completed.includes(nodeId)) throw new Error(`Temporal smoke did not record completion for ${nodeId}.`);
  if (new Set(completed).size !== completed.length) throw new Error(`Temporal smoke detected duplicate completed WorkUnits: ${completed.join(', ')}`);
  console.log('Temporal Docker smoke passed (worker restart, terminal run, lifecycle evidence, no duplicate completions).');
} catch (error) {
  smokeFailed = true;
  throw error;
} finally {
  if (originalWorkflow !== undefined) {
    try {
      // PUT is version-checked and increments the workflow version, so restore
      // the original definition using the version created by the smoke update.
      await json('http://localhost:3100/api/workflows/workflow-agent-intake', {
        method: 'PUT',
        headers: scopeHeaders,
        body: JSON.stringify({ ...originalWorkflow, version: originalWorkflow.version + 1 }),
      });
      console.log('Temporal smoke restored workflow-agent-intake.');
    } catch (restoreError) {
      console.error(`Temporal smoke could not restore workflow-agent-intake: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      if (!smokeFailed) throw restoreError;
    }
  }
  compose('down', '--remove-orphans');
}
