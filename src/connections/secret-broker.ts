/** Context used when resolving a human-friendly Connection/name reference. */
export interface SecretScope {
  tenantId?: string;
  projectId?: string;
}

/** Secret values are intentionally kept behind this interface and never enter workflow state. */
export interface SecretBroker {
  put(reference: string, value: string): Promise<void>;
  get(reference: string, scope?: SecretScope): Promise<string>;
  delete?(reference: string): Promise<void>;
}
