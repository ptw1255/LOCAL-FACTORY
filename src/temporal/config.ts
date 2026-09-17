import { readFileSync } from 'node:fs';

import type { TLSConfig } from '@temporalio/client';

export interface TemporalConnectionSettings {
  address: string;
  namespace: string;
  tls?: TLSConfig;
  apiKey?: string;
}

function configuredFile(env: NodeJS.ProcessEnv, name: string): Uint8Array | undefined {
  const file = env[name]?.trim();
  if (file === undefined || file === '') return undefined;
  try {
    return readFileSync(file);
  } catch (error) {
    throw new Error(`Temporal TLS file ${name} could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/** Build redacted, shared connection settings for the API client and worker. */
export function temporalConnectionSettings(env: NodeJS.ProcessEnv = process.env): TemporalConnectionSettings {
  const address = env.TEMPORAL_ADDRESS?.trim() || 'localhost:7233';
  const namespace = env.TEMPORAL_NAMESPACE?.trim() || 'default';
  const certFile = env.TEMPORAL_TLS_CERT_FILE?.trim() || undefined;
  const keyFile = env.TEMPORAL_TLS_KEY_FILE?.trim() || undefined;
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error('TEMPORAL_TLS_CERT_FILE and TEMPORAL_TLS_KEY_FILE must be configured together.');
  }
  const cert = configuredFile(env, 'TEMPORAL_TLS_CERT_FILE');
  const key = configuredFile(env, 'TEMPORAL_TLS_KEY_FILE');
  const rootCA = configuredFile(env, 'TEMPORAL_TLS_CA_FILE');
  const serverName = env.TEMPORAL_TLS_SERVER_NAME?.trim() || undefined;
  const tls = cert === undefined && rootCA === undefined && serverName === undefined
    ? undefined
    : {
        ...(cert === undefined ? {} : { clientCertPair: { crt: cert, key: key! } }),
        ...(rootCA === undefined ? {} : { serverRootCACertificate: rootCA }),
        ...(serverName === undefined ? {} : { serverNameOverride: serverName }),
      } satisfies TLSConfig;
  const apiKey = env.TEMPORAL_API_KEY?.trim() || undefined;
  return { address, namespace, ...(tls === undefined ? {} : { tls }), ...(apiKey === undefined ? {} : { apiKey }) };
}
