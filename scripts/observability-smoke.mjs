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

const tracePayload = {
  resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agentic-workflow-factory-smoke' } }] },
    scopeSpans: [{
      scope: { name: 'agentic-workflow-factory-smoke' },
      spans: [{
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        name: 'observability.smoke',
        kind: 1,
        startTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
        endTimeUnixNano: `${BigInt(Date.now() + 1) * 1_000_000n}`,
        attributes: [
          { key: 'run.id', value: { stringValue: 'observability-smoke' } },
          { key: 'workflow.id', value: { stringValue: 'observability-smoke' } },
        ],
      }],
    }],
  }],
};

try {
  compose('up', '-d', '--build');
  await waitFor('http://localhost:3100/api/health', async (response) => {
    if (!response.ok) return false;
    const health = await response.json();
    return health.observability?.retentionHours === 48;
  });
  await waitFor('http://localhost:6006', (response) => response.ok);
  await waitFor('http://localhost:4318/v1/traces', async () => {
    const collectorResponse = await fetch('http://localhost:4318/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tracePayload),
      signal: AbortSignal.timeout(5_000),
    });
    return collectorResponse.ok;
  });
  console.log('Observability Docker smoke passed (app health, 48-hour retention, Collector, Phoenix).');
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
