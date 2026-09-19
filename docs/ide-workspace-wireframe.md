# Optional browser workspace wireframe

> This is a compatibility/visualization surface. The FACTORY Local terminal is the
> primary authoring and operating experience; start with [Getting started](./onboarding.md).

This is the interaction contract for the file-first Workspace. It is deliberately
textual so it can be reviewed alongside the declarative resource model and kept
in sync with browser tests.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Factory  Workspace  Deployments  Observe  Connections     [▶ Run] [loop ▾]  │
├───────────────┬──────────────────────────────────────────────┬───────────────┤
│ Explorer       │ workflow.yaml  agent.reviewer.yaml          │ Operational   │
│ [Files ▾]      │                                              │ tree          │
│                │  1 apiVersion: factory/v1                   │ (read-only    │
│ ▾ workflows    │  2 kind: Workflow                            │ projection)   │
│   workflow...  │  3 metadata:                                 │               │
│ ▾ agents       │  4   id: reviewer                            │               │
│   reviewer...  │  ...                                         │               │
│                │                                              │               │
│                │                                              │               │
├───────────────┴──────────────────────────────────────────────┴───────────────┤
│ Problems (2)   Run Output   [diagnostic list / latest run status]             │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Interaction rules

- The Explorer selector offers **Files**, **Canvas**, and **Tree**; **Files** is
  the default. All three are projections of the same project resources.
- The center editor is file-backed. A dirty buffer is local state until Save;
  Save writes the source file and compilation produces an immutable artifact.
- Canvas edits that change execution semantics write the corresponding source
  modules. Position-only edits remain presentation metadata.
- Tree is read-only and derives its hierarchy from the compiled artifact.
- **Run** is the upper-left command action. It saves/compiles dirty files,
  blocks on diagnostics, then creates a run pinned to the valid artifact.
- Problems and Run Output are bottom-panel tabs, not competing primary pages.
- **Observe** is a top-level navigation destination for Runs, Logs, Traces, and
  Metrics. The legacy `#/runtime` and `#/runs` routes resolve there.
- Deployments is a separate operational view for desired/observed state and
  safe lifecycle actions; it never edits source files.

## State boundaries

The state transitions and persistence boundaries are defined in
[`ide-state-model.md`](./ide-state-model.md). The browser contract is covered by
`tests/browser/ide.spec.ts`, including navigation, file-backed tabs, Canvas
semantic saves, bottom-panel keyboard behavior, Observe, and Deployments.
