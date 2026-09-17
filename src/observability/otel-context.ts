import { context, isSpanContextValid, trace, type Context, type SpanContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

let contextManagerReady = false;

/** Install the official OpenTelemetry async context manager once per process. */
export function ensureOtelContext(): void {
  if (contextManagerReady) return;
  contextManagerReady = context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
}

export function validSpanContext(traceId: string, spanId: string): SpanContext {
  return { traceId, spanId, traceFlags: 1, isRemote: false };
}

export function activeOtelSpanContext(): SpanContext | undefined {
  ensureOtelContext();
  const active = trace.getSpanContext(context.active());
  return active === undefined || !isSpanContextValid(active) ? undefined : active;
}

/** Run asynchronous work with a standard OpenTelemetry parent context. */
export function withOtelSpanContext<T>(span: SpanContext, callback: () => T): T {
  ensureOtelContext();
  const next: Context = trace.setSpanContext(context.active(), span);
  return context.with(next, callback);
}
