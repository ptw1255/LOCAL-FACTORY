# Optional browser workspace state model

> FACTORY Local is terminal-first. This document describes the optional browser
> projection; it is not required for the 0 → 1 or N + 1 operating journeys. See
> [Getting started](./onboarding.md) and [Operating FACTORY](./operating-factory.md)
> for the canonical terminal experience.

The Workspace is a file-first authoring surface. YAML/JSON resource files are
the source of truth; Canvas and Tree are projections of the same compiled
resources. PostgreSQL stores compiled artifacts and runtime state, never an
editor buffer.

## Shell contract

```text
Workspace
├─ [▶ Run] [workflow] [environment]                 command bar
├─ Explorer [Files | Canvas | Tree]                 left view selector
├─ files / folders                                   left pane
├─ open file tabs + source editor                    center pane
├─ operational tree                                  right pane
└─ Problems | Run Output                             bottom panel

Observe     Runs | Logs | Traces | Metrics
Deployments live / stopped / starting / degraded / failed
Connections metadata, scopes, and health (never Vault references or values)
```

Within the optional browser surface, `Workspace` is the file-authoring route.
`#/studio` remains a compatibility alias for existing links. `#/runtime` and
`#/runs` resolve to `Observe`; the terminal is still the canonical local control
plane.

## Independent state machines

### Editor buffer

```text
synced ──edit──> dirty ──save──> saving ──success──> synced
                         │                         └─failure──> dirty + error
                         └─navigate──> confirm discard (or remain dirty)
```

The buffer is local to an open file. A dirty buffer cannot be used by Run until
the active source has been saved and compiled successfully.

### Compilation and artifact

```text
no artifact ──compile──> compiling ──valid──> artifact(hash)
                                  └─invalid──> problems (last valid artifact kept)
artifact(hash) ──new source──> stale (never silently selected for Run)
```

Artifacts are immutable and selected by project, workflow, environment, and
content hash. A failed compilation never replaces the last valid artifact.

### Deployment

```text
stopped ──start──> starting ──healthy──> live
live ──stop──> stopping ──complete──> stopped
starting/live ──health failure──> degraded or failed
live ──restart──> stopping ──> starting
```

Desired state (operator intent) and observed state (reconciler evidence) are
stored independently. Protected environments add an approval transition before
promotion or rollback.

### Run

```text
preflight ──valid──> queued ──accepted──> running
    └─invalid──> blocked (no WorkUnit executes)
running ──approval──> waiting ──approve──> running
running ──pause──> paused ──resume──> queued/running
running ──complete──> succeeded
running ──error──> failed / timed_out / cancelled
```

Run creation pins the selected artifact, environment, deployment context, and
input hash. Workspace Run Output surfaces the new run immediately; Observe is an
explicit destination for the full run and telemetry timeline.

## Projection boundaries

- **Files/editor → compiler:** source files are parsed, resolved, validated, and
  compiled into an immutable artifact.
- **Artifact → Tree:** the operational tree is read-only and derives hierarchy
  from workflow edges and resource references.
- **Artifact + Canvas resource → Canvas:** node positions and edge presentation
  metadata are compatibility presentation state; they do not change execution
  semantics unless an explicit source-edit workflow is invoked.
- **Run/deployment evidence → Observe/Deployments:** operational screens read
  persisted records and correlated telemetry; they do not mutate source files.

## Run preflight rules

1. If an editor buffer is dirty, save and compile it first.
2. If syntax or compiler diagnostics remain, block Run and focus Problems.
3. Select the newest valid artifact for the chosen workflow/environment, preferring
   the artifact produced by the just-completed compile.
4. Validate workflow input against its declared schema before creating a run.
5. Create one run with a synchronous client-side concurrency lock; the server
   remains the final validation boundary.
6. Show queued/running feedback in Run Output. The operator chooses Open in
   Observe when a full telemetry view is needed.

## Architecture guardrails

New behavior should be introduced behind pure state helpers or focused components
and tested independently. The existing `src/web/App.tsx` composition is a
compatibility seam, not a contract: future work should extract Workspace,
Observe, and Deployments components without changing the state machines above.
