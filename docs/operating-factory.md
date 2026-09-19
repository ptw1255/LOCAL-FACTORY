# Operating FACTORY: N + 1

This guide begins after the first workflow is running. The goal is to add more
Projects and workflows without turning local FACTORY into a collection of copied
keys, opaque agent behavior, or untraceable deployments.

## The operating model

```text
FACTORY Local (one trusted developer machine)
├── Connections                 reusable model/provider credentials in Vault
├── Projects                    separate file-backed work boundaries
│   ├── Workflows                executable WorkUnit-envelope graphs
│   ├── Artifacts                immutable compiled versions
│   └── Runs / approvals         durable operational evidence
└── Portals                      Observe, Workflow, Deployments, Factory
```

Use a new Project when the source boundary, approval policy, deployment lifecycle,
or operating purpose is distinct. Use another Workflow when work belongs to the
same Project but has a different trigger or graph.

## Add the next Project

From Core, select **Projects** and press `n`, or use:

```bash
factory project new "Release automation"
```

Then select **Workflow** and press `n` to draft its first workflow. The new Project
can use existing FACTORY-level Connections immediately; do not paste the same model
key again.

```yaml
model:
  provider: openai
  model: gpt-5-mini
  secretRef: Connection/openai
```

## Manage Connections deliberately

Connections are named, reusable capabilities. They contain a provider label,
health status, and an opaque local Vault reference; they do not contain an API key
in source control or telemetry.

In **Connections**:

| Key | Action |
| --- | --- |
| `c` | Create a Connection: name, hidden key entry, then `s` save. |
| `Enter` / `t` | Verify that FACTORY can read the selected Vault value. |
| `d`, then `s` | Remove a Connection and its local Vault value. |
| `r` | Refresh health records. |
| `Esc` | Cancel or return to Core. |

Use distinct names for distinct credentials, even for one provider: for example,
`openai-personal`, `openai-team`, and `typesafe-ai`. Rotating a key means saving a
new value under the same Connection name; workflows continue to use the semantic
reference.

Removing a reusable Connection can affect more than one Project. Confirm that no
workflow needs it before pressing `s`.

## Author the next workflow safely

For each workflow, use the guided draft to state what is deterministic, what is
agentic, what can cause a side effect, and where approval is required.

```text
deterministic preparation
        ↓
bounded agent decision
        ↓
approval before side effect (when needed)
        ↓
deterministic publish / consume
```

Keep these responsibilities explicit:

- **WorkUnit envelope:** input/output schemas, timeout, retry, idempotency, and
  execution kind.
- **Agent box:** purpose, declared tools and skills, model route, boundaries,
  budget, and telemetry policy.
- **Policy:** which operations need approval and in which environment.
- **Artifact:** the immutable compiled input to a run or deployment.

Use `a` to draft or revise, `v` to validate, `a` to approve a proposal, and `y` to
apply it. The extra review step is intentional: an authoring assistant can propose
files, but cannot silently mutate a Project.

## Operate runs and approvals

The terminal pages are the default operations path:

| Surface | Use it for |
| --- | --- |
| **Runs** | See execution state and open a run timeline. |
| **Approvals** | Approve or deny waiting operations. |
| **Portals → Observe** | Inspect the correlated run lifecycle and telemetry. |
| **Deployments** | See desired vs. observed deployment state and act safely. |
| **Factory** | Inspect local runtime health and metrics. |

Run controls are also available directly:

```bash
factory observe <run-id> --follow
factory approve <run-id> "reviewed local result"
factory deny <run-id> "missing required evidence"
factory pause <run-id>
factory resume <run-id>
factory cancel <run-id>
```

Evidence follows the run. FACTORY records standard logs, metrics, traces, approval
decisions, outputs, and operational events with shared run context. Short-lived
telemetry is retained for 48 hours by default; it should not contain secret values
or prompt/output content unless you explicitly build a different policy.

## Deploy a local workflow

Compile first, then create or operate the deployment through the Deployments
surface. A deployment tracks desired state separately from observed health; this is
why it behaves like an operational view rather than an authoring editor.

Protected environments require the configured evidence and approval path before
promotion. Local development workflows can run without a deployment, which keeps
the first iteration lightweight.

## Optional local model path

Use Ollama when a workflow should call a model already running on the machine. It
does not need a Vault Connection:

```yaml
model:
  provider: ollama
  model: llama3.2
  endpoint: http://host.docker.internal:11434
```

Keep Ollama optional. The default FACTORY stack stays lean; model weights are not
baked into the application image.

## Browser dashboard: optional portals

The browser dashboard is useful for visual workflow and observability projections,
but is not required to author or operate a loop. Open it only when useful:

```bash
factory open
```

The terminal remains the canonical local control plane. It works even when browser
serving is disabled with `factory --no-web`.

## Maintain the local factory

```bash
launch-factory             # start services and enter terminal UI
factory status             # service status
factory logs app           # application logs
factory restart            # restart without deleting volumes
factory down               # stop services; volumes are retained
npm run check              # typecheck, tests, and production web build
```

Do not use `docker compose down -v` unless you intentionally want to erase local
Postgres, Vault, and workspace data. Project source files are host-visible under
`~/agent-factory/projects/<project-slug>/` and are intentionally ignored by the
FACTORY repository; initialize Git inside an individual project if you want to version
that project's declarative resources. Keep provider keys local and use Git for
declarative resources, policies, tests, and documentation only.
