import { execFileSync, spawnSync } from 'node:child_process';

const enabled = process.env.OTEL_DOCKER_SMOKE === '1';
if (!enabled) {
  console.log('Observability Docker smoke skipped (set OTEL_DOCKER_SMOKE=1 to enable).');
  process.exit(0);
}

const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
if (docker.status !== 0) {
  console.log('Observability Docker smoke skipped (Docker daemon unavailable).');
  process.exit(0);
}

const diagnosticServices = ['app', 'postgres', 'vault', 'phoenix', 'otel-collector'];
const compose = (...args) => execFileSync('docker', ['compose', '--profile', 'observability', ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://otel-collector:4318',
    PHOENIX_UI_URL: process.env.PHOENIX_UI_URL ?? 'http://localhost:6006',
  },
});

function dumpDiagnostics() {
  console.error('\nObservability Docker smoke diagnostics (bounded to the smoke services):');
  try {
    compose('ps');
  } catch (error) {
    console.error(`Could not list Compose services: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    compose('logs', '--no-color', '--tail', '120', ...diagnosticServices);
  } catch (error) {
    console.error(`Could not read Compose logs: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitFor(url, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (await predicate(response)) return;
    } catch {
      // Services are still starting; continue polling until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

const smokeTimestamp = BigInt(Date.now()) * 1_000_000n;
const smokeAttributes = [
  { key: 'run.id', value: { stringValue: 'observability-smoke' } },
  { key: 'workflow.id', value: { stringValue: 'observability-smoke' } },
];
const logPayload = {
  resourceLogs: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agentic-workflow-factory-smoke' } }] },
    scopeLogs: [{
      scope: { name: 'agentic-workflow-factory-smoke' },
      logRecords: [{ timeUnixNano: `${smokeTimestamp}`, severityText: 'INFO', body: { stringValue: 'observability smoke log' }, attributes: smokeAttributes }],
    }],
  }],
};
const metricPayload = {
  resourceMetrics: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agentic-workflow-factory-smoke' } }] },
    scopeMetrics: [{
      scope: { name: 'agentic-workflow-factory-smoke' },
      metrics: [{ name: 'observability.smoke', gauge: { dataPoints: [{ timeUnixNano: `${smokeTimestamp}`, asDouble: 1, attributes: smokeAttributes }] } }],
    }],
  }],
};

async function postSignal(path, payload) {
  const response = await fetch(`http://localhost:4318${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
  return response.ok;
}

try {
  compose('up', '-d', '--build');
  await waitFor('http://localhost:3100/api/health', async (response) => {
    if (!response.ok) return false;
    const health = await response.json();
    return health.observability?.retentionHours === 12
      && health.observability?.otlpExportEnabled === true
      && health.observability?.exporterHealth?.status === 'healthy';
  });
  await waitFor('http://localhost:6006', (response) => response.ok);
  await waitFor('http://localhost:4318/v1/logs', () => postSignal('/v1/logs', logPayload));
  await waitFor('http://localhost:4318/v1/metrics', () => postSignal('/v1/metrics', metricPayload));
  console.log('Observability Docker smoke passed (app health, 12-hour retention, logs/metrics, Collector, Phoenix).');
} catch (error) {
  console.error(`Observability Docker smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  dumpDiagnostics();
  throw error;
} finally {
  try {
    compose('down', '--remove-orphans');
  } catch (cleanupError) {
    console.error(`Observability smoke cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
}
