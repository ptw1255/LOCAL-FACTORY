/** Small, dependency-free semantic-convention surface shared by local and Temporal runtimes.
 * These keys intentionally follow OpenTelemetry and OpenInference naming so the
 * persisted event stream can be exported to an OTLP-compatible backend.
 */
export const telemetryAttributes = {
  serviceName: 'service.name',
  serviceVersion: 'service.version',
  runId: 'run.id',
  traceId: 'trace.id',
  spanId: 'span.id',
  unitId: 'unit.id',
  deploymentId: 'deployment.id',
  spanKind: 'openinference.span.kind',
  modelName: 'llm.model_name',
  agentId: 'agent.id',
  agentVersion: 'agent.version',
  metricName: 'metric.name',
  metricValue: 'metric.value',
} as const;

export const telemetryResource = {
  [telemetryAttributes.serviceName]: 'agentic-workflow-factory',
  [telemetryAttributes.serviceVersion]: '0.1.0',
  'telemetry.sdk.name': 'opentelemetry',
} as const;
