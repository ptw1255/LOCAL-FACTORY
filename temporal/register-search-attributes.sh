#!/bin/sh

# Register the factory's visibility fields against a local Temporal namespace.
# The auto-setup image already waits for the server and creates its generic
# Custom*Field attributes; this small idempotent sidecar adds the named fields
# used by the control plane without requiring a separate admin installation.
set -u

namespace="${DEFAULT_NAMESPACE:-default}"

until temporal operator search-attribute list --namespace "$namespace" >/dev/null 2>&1; do
  sleep 1
done

for definition in \
  "FactoryId:Keyword" \
  "WorkflowVersion:Keyword" \
  "Environment:Keyword" \
  "Status:Keyword" \
  "CorrelationId:Keyword" \
  "ReleaseBundle:Keyword" \
  "AgentVersions:Text"; do
  name=${definition%%:*}
  type=${definition#*:}
  # A repeated Compose invocation may reuse the Temporal volume. Creation is
  # intentionally idempotent: an already-registered field is safe to ignore.
  temporal operator search-attribute create \
    --namespace "$namespace" \
    --name "$name" \
    --type "$type" >/dev/null 2>&1 || true
done

echo "Temporal factory search attributes ready in namespace $namespace."
