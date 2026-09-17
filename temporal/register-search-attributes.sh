#!/bin/sh

# Register the factory's visibility fields against a local Temporal namespace.
# The auto-setup image already waits for the server and creates its generic
# Custom*Field attributes; this small idempotent sidecar adds the named fields
# used by the control plane without requiring a separate admin installation.
set -u

namespace="${DEFAULT_NAMESPACE:-default}"

while ! existing_attributes="$(temporal operator search-attribute list --namespace "$namespace" 2>/dev/null)"; do
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
  # A repeated Compose invocation may reuse the Temporal volume. Check the
  # current list first so an existing field is idempotent while an actual
  # create failure remains visible and blocks the worker from starting.
  if printf '%s\n' "$existing_attributes" | awk -v name="$name" '$1 == name { found = 1 } END { exit found ? 0 : 1 }'; then
    continue
  fi
  if ! temporal operator search-attribute create \
    --namespace "$namespace" \
    --name "$name" \
    --type "$type"; then
    echo "Failed to register Temporal search attribute $name in namespace $namespace." >&2
    exit 1
  fi
  existing_attributes="$(printf '%s\n%s' "$existing_attributes" "$name")"
done

echo "Temporal factory search attributes ready in namespace $namespace."
