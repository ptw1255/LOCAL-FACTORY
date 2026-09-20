# FACTORY Local: 0 → 1

This guide takes a new local installation from no running services to one
observable workflow. FACTORY is terminal-first: the terminal control plane is the
normal path, while the browser dashboard is optional.

## What you will have

```text
FACTORY Local
├── reusable Connection      one model key in local Vault
├── Project                  one file-backed work boundary
├── Workflow                 one graph of WorkUnit envelopes
├── Artifact                 one compiled, immutable version
└── Run evidence             compact logs, metrics, approvals, and outputs
```

## Before you begin

- macOS with Docker Desktop running.
- Node.js 22 or newer, only if you are starting from a source checkout.
- A hosted-model API key, or a locally running Ollama model. The API key is
  optional until a workflow invokes that provider.

The canonical checkout is `/Users/parker/agent-factory`.

## 1. Install and launch FACTORY Local

From the checkout:

```bash
cd "/Users/parker/agent-factory"
npm install
```

Install the user-level launcher once if it is not already available:

```bash
npm install --global --prefix "$HOME/.local" .
ln -sfn "$HOME/.local/bin/factory" "$HOME/.local/bin/launch-factory"
```

Then, from any directory, launch FACTORY:

```bash
launch-factory
```

It starts the app, PostgreSQL, and local development Vault; waits for health; and
opens **FACTORY LOCAL**. Press `q` to leave the terminal interface. Docker services
continue running until you stop them with `factory down`.

If the command is not found, use the checkout directly:

```bash
cd "/Users/parker/agent-factory"
npm run factory -- tui
```

## 2. Add one reusable model Connection

From FACTORY LOCAL, select **Connections**, then:

1. Press `c`.
2. Enter a Connection name, such as `typesafe-ai`.
3. Paste the API key at the hidden prompt and press Enter.
4. Press `s` to save.

The key is stored in local Vault. FACTORY stores only Connection metadata and a
non-secret Vault reference; it never writes the key into YAML, Git, API responses,
logs, telemetry, or Postgres.

Connections live above Projects. Add the key once, then reference it from any
Project using its semantic name:

```yaml
secretRef: Connection/typesafe-ai
```

In the Connections view, `Enter` or `t` checks Vault access for a selected
Connection, `d` stages removal, `s` confirms removal, `r` refreshes, and `Esc`
cancels or returns to Core.

The equivalent CLI commands are:

```bash
factory secrets set typesafe-ai --provider openai-compatible --from-clipboard
factory secrets test typesafe-ai
factory secrets list
```

The bundled Vault is development mode for a trusted developer machine. It is not a
shared or production secret-management deployment.

## 3. Create a Project

Projects are the durable, file-backed boundary. A Project owns its workflows,
artifacts, run history, and approval policy; it does **not** own a duplicate copy of
your API key.

In Core, select **Projects** and press `n`. Enter a name and description. FACTORY
creates the Project and its initial `factory.yaml` resource.

CLI equivalent:

```bash
factory project new "Code review factory"
```

## 4. Create and draft the first Workflow

Select **Workflow**. With an empty Project, select **Draft first Workflow with AI**
or press `n`. FACTORY asks for a workflow name, then a guided brief covering:

- objective and trigger;
- input contract and deterministic preparation;
- the bounded agent responsibility;
- any external action and approval boundary;
- observable output and constraints.

FACTORY produces a WorkUnit blueprint and a reviewable file proposal. This is the
safe authoring lifecycle:

```text
intent → guided brief → WorkUnit blueprint → file proposal
      → validation → approval → apply → immutable artifact
```

Review the proposal. Press `v` to revalidate, `a` to approve, and `y` to apply. No
Project files change before validation and explicit approval. `Esc` is global: it
cancels a prompt and walks back toward Core.

## 5. Connect the Workflow to a model

Agent YAML references the reusable Connection by name:

```yaml
model:
  provider: openai-compatible
  model: your-model-name
  endpoint: https://provider.example/v1
  secretRef: Connection/typesafe-ai
```

For an Ollama model, no Vault key is required:

```yaml
model:
  provider: ollama
  model: llama3.2
  endpoint: http://host.docker.internal:11434
```

## 6. Validate, run, and observe

From the Workflow view:

- `v` validates and compiles an immutable artifact.
- `p` starts a run from that artifact.
- **Runs** shows the current execution list.
- **Approvals** presents any waiting decisions.
- **Portals → Observe** opens the correlated operational view.

Observe is where a run’s compact terminal log, metrics, status transitions, and durable
operation evidence meet. Trace export is disabled for now. Telemetry defaults to a
12-hour retention window; durable
run evidence has its own configured retention policy.

At this point the first loop is complete: it has a bounded authoring path, a
compiled artifact, explicit execution, and evidence you can inspect.

## Next

Continue with [Operating FACTORY](./operating-factory.md) to add Projects and
workflows, manage Connections, operate deployments, and use the optional browser
views without making them the authoring dependency.
