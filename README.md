# Agentic Workflow Factory

Agentic Workflow Factory is a terminal-first, API-first runtime for composing deterministic
code, bounded agents, human approvals, connectors, evaluators, and consumers into
durable workflows. Each node is a versioned work unit with an explicit contract;
each agent is a policy-bound box with declared purpose, skills, tools, budgets,
boundaries, approvals, and telemetry rules.

The product is designed for software and operations teams that want agents to do
useful work without turning the system into an opaque autonomous process. A typical
flow can validate an issue, run deterministic preparation code, ask an agent to plan
or implement a change, execute tests, route to human review, and publish evidence.

The implementation lives under [`src/`](src/). The product and factory roadmaps
remain at the repository root and under [`FACTORY/`](FACTORY/).

## Start here

FACTORY has two intentional journeys:

| Journey | Outcome | Guide |
| --- | --- | --- |
| **0 → 1** | Install FACTORY Local, add one reusable model Connection, create a Project, author, run, and observe a first workflow. | [Getting started](docs/onboarding.md) |
| **N + 1** | Add further Projects and workflows without duplicating keys, operate runs and approvals, and manage local deployments. | [Operating FACTORY](docs/operating-factory.md) |

Use `launch-factory` from any terminal after the one-time local installation. It
starts the local stack and opens the terminal control plane. The browser dashboard
is optional; FACTORY Local is terminal-first.

## Status

The repository is an actively developed MVP. The current release includes a
terminal control plane, file-backed Projects, versioned workflows and agent boxes, a local durable executor, an optional
Temporal execution adapter, PostgreSQL persistence, Vault-backed local secrets, standardized
OpenTelemetry/OpenInference-style telemetry, bounded proposals, and factory metrics.
The model-provider and repository-execution adapters are explicit, testable seams:
OpenAI Responses, Anthropic Messages, Gemini generate-content, Ollama, and generic
OpenAI-compatible local servers are available without changing workflow semantics.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` requests to the Fastify server on
port 3100. Without `DATABASE_URL`, runtime state is stored in `.data/state.json`.
Without Vault configuration, credential writes are rejected rather than persisted.

### FACTORY CLI

The repository includes a terminal-first CLI for managing, running, observing, and
deploying the local Docker factory. The web dashboard remains an optional visual
surface; the CLI is the primary control plane.
Run it through npm during development. On the standard local installation, use the
user-level `launch-factory` command from any directory:

```bash
npm run factory --help
launch-factory                  # start the stack and enter the terminal monitor
npm run factory -- tui          # equivalent when working from this checkout
factory status                  # show Docker service status
factory build                   # build images without starting services
factory deploy                  # build, start, and wait for health
factory logs app                # tail app logs
factory down                   # stop services (volumes are preserved)
factory observe --follow        # live runs, approvals, and deployments
factory tui                     # interactive monitor (q/a/d/r controls)
factory dashboard               # quick-launch terminal portals
factory project                 # inspect the active file-backed Project
factory workflow                # inspect Workflow and WorkUnit graphs
factory project new "My project"
factory workflow new "My workflow" --project <project-id>
factory author propose <workflow-id> "Add an approval before publish" --project <project-id>
factory author import proposal.json --project <project-id>
factory secrets set openai --provider openai
factory secrets set typesafe-ai --provider openai-compatible --from-clipboard
factory secrets list
factory secrets test typesafe-ai
factory secrets remove typesafe-ai
factory edit workflows/review.workflow.yaml  # edit a local resource with $EDITOR
factory approve <run-id>        # approve a waiting run
factory deny <run-id> "reason"  # deny a waiting run
factory --no-web                # run a CLI-only stack without static dashboard serving
```

`launch-factory` is the single-command launcher for local development. It starts the
Compose stack, waits for `/api/health`, and enters the terminal monitor. Use
`factory dashboard` for the terminal quick-launch selector, or `factory open` when
you explicitly want the optional browser dashboard.
`factory observe <run-id> --follow` streams a correlated run timeline;
`factory tui` adds keyboard controls (`q` quit, `r` refresh, `a` approve first pending
approval, `d` deny it). In CI or another non-interactive shell, the monitor prints one
snapshot and exits. Use `FACTORY_BASE_URL` for a different API URL and
`factory --all` to include the optional Temporal, observability, and Ollama profiles.
Add `--no-web` when the deployment should expose only the API/control plane for
terminal-native operation.

### Model API keys and local secrets

The normal local flow is through FACTORY, not the Vault CLI. Store each hosted-model
key once for FACTORY Local, then reuse its Connection from any Project:

```bash
factory secrets set typesafe-ai --provider openai-compatible --from-clipboard
factory secrets test typesafe-ai
factory secrets list
```

`--from-clipboard` reads a macOS clipboard value without echoing it or placing it in
shell history. Omit it to paste at FACTORY's hidden terminal prompt. FACTORY starts
its local Vault service as needed, stores the value under a tenant-scoped Vault
reference, and creates the corresponding reusable Connection metadata. The key is
never returned by the CLI or API.

Reference that Connection by name—not by its Vault path—in agent YAML:

```yaml
model:
  provider: openai-compatible
  model: your-model-name
  endpoint: https://provider.example/v1
  secretRef: Connection/typesafe-ai
```

`factory secrets remove typesafe-ai` removes both the FACTORY-level Connection
metadata and its Vault value after confirmation. Direct Vault paths and provider
environment variables remain supported for migration and smoke-test compatibility,
but are advanced paths.
The bundled Vault uses development-mode local security; it is suitable for a trusted
developer machine, not a shared or production deployment.
The authoring model is `Project → Workflow → WorkUnit`. A Project is the durable,
tenant-scoped file boundary. A Workflow is a graph whose nodes reference versioned
WorkUnit envelopes. The terminal renders that model directly: Enter opens a Workflow,
then a WorkUnit's purpose, execution kind, schema, timeout, retry, idempotency, source,
and agent binding. YAML remains the source of truth, but it is an advanced view opened
with `o`, not the primary authoring experience.

AI authoring follows a controlled lifecycle:

```text
intent → guided brief → WorkUnit blueprint → file proposal → validation → approval → apply → artifact
```

Press `a` on a Workflow to open the guided draft. FACTORY asks for the objective,
trigger, input contract, deterministic preparation, bounded agent responsibility,
external action, approval boundary, observable output, and constraints. It converts those answers into
an ordered WorkUnit blueprint, renders that blueprint before the semantic file diff,
creates baseline input/output JSON Schema descriptions and any required bounded Agent
envelope, and validates the generated resource scheme with the real compiler. Use `a` to approve,
`y` to apply, `v` to revalidate, or `d` to reject without changing files. Every
lifecycle action records a correlated log event and durable operation evidence. Apply
checks the original file hashes, writes the proposal as one optimistic batch, and
compiles an immutable artifact; stale or invalid proposals fail closed.

External authoring agents can submit exact resource files through
`POST /api/projects/:projectId/authoring/proposals` or `factory author import`. This is
the integration point for Codex or another chat agent: it can construct Project,
Workflow, Agent, WorkUnit, Canvas, Policy, Connection, Environment, and Schema files,
but cannot mutate the Project until the proposal validates and a user approves it.
The imported JSON shape is:

```json
{
  "goal": "Add a bounded review agent and require approval before publishing",
  "changes": [
    { "path": "workflows/review.workflow.yaml", "content": "apiVersion: factory.agentic/v1\n..." },
    { "path": "units/review.unit.yaml", "content": "apiVersion: factory.agentic/v1\n..." }
  ]
}
```

Project controls are `n` to create a Project, `s` to switch Projects, `w` to draft a
Workflow with AI, and `v` to validate and compile. Workflow controls are `a` to revise
through the guided draft, Enter to inspect WorkUnits, `v` to compile, and `p` to run. Escape is global
navigation: it cancels a prompt, leaves advanced source editing, walks from WorkUnit to
Workflow to home, and returns from a run to Runs.

The Core landing page always shows the active Project name and ID. A Project with no
Workflows gets an explicit **Draft first Workflow with AI** row: press Enter or `n` to
name the Workflow, complete the guided brief, and review the resulting blueprint and
file proposal. If no Project is selected, Enter routes back to Projects first.

The non-interactive equivalent is:

```bash
factory project new "Code review factory"
factory workflow new "Review a pull request" --project <project-id-from-the-first-command>
factory workflow --project <project-id>
factory author propose review-a-pull-request "Add a bounded coding agent and human approval" --project <project-id>
```

### Control-plane authentication

Local development defaults to an implicit admin principal so the Studio works without
setup. Set `FACTORY_AUTH_MODE=required` before exposing the API to shared users. A
single admin token can be supplied with `FACTORY_API_TOKEN`, or use a JSON list for
scoped roles:

```bash
export FACTORY_AUTH_MODE=required
export FACTORY_AUTH_TOKENS='[{"token":"author-token","principal":{"id":"author-1","role":"author","tenantIds":["tenant-local"],"projectIds":["project-local"]}}]'
```

Clients send `Authorization: Bearer <token>`. Roles are `reader`, `author`,
`operator`, `reviewer`, and `admin`; tenant/project headers are accepted only when
the principal is scoped to them. Authentication and authorization decisions are
recorded as redacted `authz.*` events. Secret values are never included in those
events or API responses.

### Local Ollama models

Agent boxes can execute local Ollama models without a hosted provider. Start Ollama
on the host, pull a model, and declare it in YAML:

```bash
ollama pull llama3.2
```

```yaml
model:
  provider: ollama
  model: llama3.2
  # Optional; defaults to OLLAMA_BASE_URL or http://127.0.0.1:11434
  endpoint: http://host.docker.internal:11434
  provisioning:
    mode: pull-on-start
    # Optional digest pins the installed model manifest.
    # digest: sha256:...
```

When the app runs in Docker Desktop, `host.docker.internal` reaches Ollama on the
host. For a fully containerized setup, use the optional Compose service instead:

```bash
OLLAMA_BASE_URL=http://ollama:11434 docker compose --profile ollama up --build
docker compose --profile ollama exec ollama ollama pull llama3.2
```

### Local OpenAI-compatible servers

LM Studio, vLLM, and LocalAI can be used through the same provider-neutral route
contract. Set the endpoint to the server's OpenAI-compatible `/v1` URL and use
`provider: lmstudio` (or `openai-compatible`, `vllm`, or `localai`):

```yaml
model:
  provider: lmstudio
  model: qwen2.5-coder-7b-instruct
  endpoint: http://host.docker.internal:1234/v1
```

The runtime calls `/chat/completions`, supports bounded retries, tool declarations,
structured-output hints, streaming, usage metadata, and request correlation. API
keys are optional for local servers; when needed, set `LM_STUDIO_API_KEY` or use
the agent's Vault-backed `secretRef`. In Compose, the endpoint defaults to
`OPENAI_COMPATIBLE_BASE_URL` and then `LM_STUDIO_BASE_URL` (otherwise
`http://host.docker.internal:1234/v1` inside Docker).

With `pull-on-start`, the app checks `/api/tags` during startup and pulls the model
when it is missing. It retries provisioning on the first run if Ollama was not yet
ready. `never` (the default) requires the model to already exist; `baked` is reserved
for preloaded model volumes. The runtime records an `llm.completed` trace for each
Ollama call and preserves the agent's declared input/output capture and network
policies.

### Bounded model routing

An agent can declare a bounded list of provider routes. `fallback` tries each route in
order and records route failures/selections in the same run trace; `single` uses only
the first route. `ensemble` invokes each bounded route and returns a deterministic,
provider-labelled text aggregation; ensemble routes are text-only and reject tool
calls because repeating side effects across providers would be unsafe. Each route may
override the provider, model, endpoint, or Vault secret reference while inheriting the rest of the agent policy. Routes may also
declare required adapter capabilities (`text`, `structured_output`, `streaming`,
`tools`, `usage`, `request_ids`) and an `adapterVersion`; a route fails closed when
the selected adapter cannot satisfy those requirements:

```yaml
model:
  routing:
    strategy: fallback
    maxAttempts: 2
  routes:
    - provider: openai
      model: gpt-5-mini
      secretRef: connections/openai
    - provider: ollama
      model: llama3.2
      endpoint: http://host.docker.internal:11434
      capabilities: [text, usage]
      adapterVersion: ollama-v1
```

Routing is bounded to eight declared attempts and does not expose API keys in YAML,
PostgreSQL, or telemetry. Built-in routes include OpenAI, Anthropic, Gemini, Ollama,
and OpenAI-compatible local servers; additional adapters can implement the same
provider-neutral contract.

### OpenAI Responses API

Hosted agent boxes use the provider-neutral runtime with a server-side Responses API
official OpenAI Node SDK Responses adapter. Configure the key with
`factory secrets set openai --provider openai` and reference the Connection name from YAML:

```yaml
model:
  provider: openai
  model: gpt-5-mini
  secretRef: Connection/openai
  streaming: true
```

The default runtime adapter is the official `openai` Node SDK (`maxRetries: 0`, so
the workflow dispatcher owns retry policy) and defaults to `store: false`. It
normalizes text, structured output, streaming, tool calls, usage, finish state,
request IDs, and typed provider failures. Prompt/output capture remains opt-in in
the agent observability policy. The lower-level HTTP adapter remains available for
compatibility and deterministic transport tests. An external smoke test is
intentionally opt-in and never runs in default CI:

```bash
OPENAI_SMOKE=1 OPENAI_API_KEY=… npm run test -- --run src/runtime/openai.smoke.test.ts
```

The same opt-in boundary covers the other provider adapters. These tests never
run in the default suite and read credentials only from the process environment:

```bash
ANTHROPIC_SMOKE=1 ANTHROPIC_API_KEY=… npm run test -- --run src/runtime/provider.smoke.test.ts
GEMINI_SMOKE=1 GEMINI_API_KEY=… npm run test -- --run src/runtime/provider.smoke.test.ts
OLLAMA_SMOKE=1 OLLAMA_MODEL=llama3.2 npm run test -- --run src/runtime/provider.smoke.test.ts
LOCAL_MODEL_SMOKE=1 LOCAL_MODEL_BASE_URL=http://127.0.0.1:1234/v1 LOCAL_MODEL_NAME=qwen2.5-coder-7b npm run test -- --run src/runtime/provider.smoke.test.ts
```

Smoke tests assert only that a provider returns non-empty normalized text and a
model identity; prompts and outputs are not persisted by the test harness.

### Local repository checks

Set `REPOSITORY_WORKSPACE` to expose the bounded repository API. Only `npm test`,
`npm run test:integration`, `npm run lint`, `npm run typecheck`, and `npm run build`
can execute; arbitrary commands and paths outside the configured root are rejected:

```bash
REPOSITORY_WORKSPACE=/path/to/repository npm run server
```

Use `GET /api/repository` to inspect the workspace and `POST /api/repository/check`
with `{ "command": "npm test" }` to receive exit code, duration, timeout state, and
truncated output evidence.

Check processes receive a minimal toolchain environment (PATH, temporary-directory,
locale, and CI hints); factory credentials, proxy settings, and connection
configuration are not inherited. Allow-listed npm checks also run with offline,
audit-disabled, and funding-disabled settings to prevent implicit package-manager
network calls. For stronger isolation, declare the container sandbox on a
`repositoryCheck` step. It uses a preloaded image (`--pull=never`), a read-only
workspace, `network=none`, dropped capabilities, `no-new-privileges`, and bounded
CPU, memory, PID, and temporary-file resources:

```yaml
kind: connector
type: repositoryCheck
config:
  command: npm test
  sandbox:
    mode: container
    image: node:22-bookworm-slim
    memoryMb: 512
    cpus: 1
    pidsLimit: 256
```

The image must already exist on the worker; no network pull is permitted. The
check result and correlated operation evidence include the selected sandbox mode,
network policy, image, and resource limits. Process mode remains the default for
lightweight local development, while untrusted checks should use the container
mode (or an equivalent isolated worker deployment). Repository checks, patch
artifacts, and Git lifecycle results also carry a credential-free remote identity
(or a stable local-workspace identity when no remote exists).

Production workers can make the boundary mandatory with
`REPOSITORY_CHECK_SANDBOX_REQUIRED=true`; any check that does not explicitly
declare `sandbox.mode: container` is then rejected before execution. This policy
is intentionally opt-in so the default local flow does not require Docker.

The real Docker boundary is covered by an opt-in smoke test (CI runs it after
pulling the pinned check image):

```bash
docker pull node:22-bookworm-slim
DOCKER_CHECK_SMOKE=1 npm test -- --run src/repository/workspace.test.ts
```

If GitHub integration is configured with `GITHUB_TOKEN`,
`GITHUB_REPOSITORY_OWNER`, and `GITHUB_REPOSITORY_NAME`, the bounded
`POST /api/repository/pull-request` endpoint can open a reviewable PR from an
already-created branch. The token is used only in the Authorization header and is
never included in request payloads or telemetry.

Repository delivery can also be composed directly in a declarative workflow. Use
`repositoryReview` to poll reviewer approvals and merge state, then place an
explicitly approval-gated `repositoryMerge` step after it:

```yaml
- id: review
  type: repositoryReview
  config:
    number: 42
    requiredApprovals: 1
    timeoutMs: 180000
    intervalMs: 5000
- id: merge
  type: repositoryMerge
  config:
    number: 42
    method: squash
    requiresApproval: true
```

Review polling is read-only and produces bounded statuses (`approved`,
`changes_requested`, `merged`, `closed`, or `timed_out`). Merge is a separate
side effect and cannot run until the normal WorkUnit approval boundary is
resolved. Both steps persist pull-request number, review/merge status, approval
counts, and merge SHA as payload-free operation evidence.

Useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run demo
npm run server
```

Pull requests run the same `npm run check` gate in GitHub Actions with a PostgreSQL
16 service. The default test suite remains network-free apart from that local service;
Vault transport boundaries use deterministic mocks, while the Docker Compose profile
is available when a real local Vault probe is needed.

### YAML-first authoring

Project YAML is the source of truth for loop topology, agent boxes, work-unit
contracts, and runtime policy. The database stores the compiled runtime index,
immutable versions, run state, and 48-hour telemetry; it is not the authoring
surface. Keep YAML in Git, review it like code, and use the Studio primarily to
inspect the operational workflow graph or open the legacy canvas when visual editing helps.

The repository includes a complete example at
[`examples/code-review-loop.yaml`](examples/code-review-loop.yaml). Validate or
inspect any project definition with the local CLI:

For a guided first run—from Docker startup through source authoring, Observe,
deployment, and restart—see [`docs/onboarding.md`](docs/onboarding.md).

The file-backed format uses `factory.yaml` as the Project entrypoint and keeps
resources independently reviewable: `workflows/*.workflow.yaml`,
`agents/*.agent.yaml`, `units/*.unit.yaml`, `policies/*.policy.yaml`,
`connections/*.connection.yaml`, `environments/*.environment.yaml`,
`schemas/*.schema.json`, and `canvas/*.canvas.yaml`. Every file uses the same
`apiVersion`, `kind`, `metadata.id`, `metadata.version`, and `spec` envelope.
References resolve by stable `Kind/id`, so renaming or moving a file does not
change identity. Environment values merge from the project defaults, then the
selected environment resource, then workflow-local overrides; later layers
win and secret values are rejected at every layer (use Vault `secretRef`).

Environment overlays may be grouped by resource kind (for example,
`spec.overrides.agents.reviewer.limits.maxIterations`) or addressed directly
with a stable key such as `Agent/reviewer`. Agent and workflow contracts can
reuse a JSON Schema with `inputSchema: '$ref:Schema/request'` or
`inputSchema: { $ref: Schema/request }`. Canvas files only contribute node
positions; policy and connection references remain explicit on workflow steps.

```bash
npm run factory -- validate examples/code-review-loop.yaml
npm run factory -- plan examples/code-review-loop.yaml
npm run factory -- workflow examples/code-review-loop.yaml
# compatibility alias:
npm run factory -- tree examples/code-review-loop.yaml
npm run factory -- run examples/code-review-loop.yaml workflow-code-review
```

The control plane exposes the same workflow for automation and GitOps tooling:

```text
GET  /api/projects/:projectId/declarative.yaml  # export the project
POST /api/projects/:projectId/declarative       # replace project config from { source }
GET  /api/projects/:projectId/artifacts/diff    # compare immutable artifacts with ?from=&to=
POST /api/projects/:projectId/migrate            # preview by default; write with { dryRun: false }
```

Imports are validated and compiled through the same canonical schemas used by the
runtime. A failed import leaves the existing project configuration untouched.

Deterministic runs can be replayed from their pinned workflow definition by an
operator (`POST /api/runs/:runId/replay`). The bounded replay report compares
completed nodes and output structure without returning captured payloads. Reports
are durable and queryable (`GET /api/replays` and `GET /api/replays/:id`) and include
only structural differences and SHA-256 output fingerprints. Runs that include
agents, network calls, notifications, or other nondeterministic units are rejected
instead of silently replaying a newer or different behavior.

Replay reports can be materialized into a small evaluator dataset for regression
work (`POST /api/evaluation-datasets` with `{ "name": "...", "reportIds": [...] }`).
Dataset cases reference reports and run/version provenance; prompts, outputs, and
secrets are never copied into the dataset. List or inspect datasets with
`GET /api/evaluation-datasets` and `GET /api/evaluation-datasets/:id`.
Evaluate a dataset with `POST /api/evaluation-datasets/:id/evaluate` and a
`threshold` between 0 and 1. The payload-free aggregate (pass rate, status counts,
threshold, and promotion decision) is retained as `lastEvaluation` so Observe and
deployment gates can inspect the most recent result after a restart.

Workflows can also score an upstream value inline with the deterministic `evaluator`
node. Supported modes are `equals`, `contains`, `fieldEquals`, `numericGte`, and
`exists`; each returns `{ score, threshold, passed, mode }`. Set
`failOnThreshold: true` when a failed score must stop the run, or route on the
payload's `passed` value for an explicit remediation branch. The evaluator never
stores the compared payload in telemetry beyond the normal opt-in capture policy.

### Artifact-backed run data

Large event payloads and completed unit outputs are stored outside the control-plane
state as content-addressed artifacts. Runs persist only an `artifactRef` containing
the SHA-256 identity, content type, size, and tenant/project scope; the executor
resolves references before passing inputs to downstream units. This keeps PostgreSQL
rows and JSON state bounded without changing workflow semantics. Local development
uses a filesystem store at `.data/artifacts` (or `ARTIFACT_STORE_DIR`); Docker mounts
that directory as the `artifact_data` volume. Artifacts follow the same 48-hour
retention window as runtime events and are pruned by the observability cleanup loop.

Prompt and model output capture remains governed by each agent's observability policy;
artifact storage does not opt those fields in.

## Run with Docker Desktop

Docker Desktop can run the app and PostgreSQL together:

```bash
docker compose up --build
```

Open <http://localhost:3100>. The app persists its control-plane state in PostgreSQL;
the `postgres_data` volume keeps it across restarts. The `DATABASE_URL` environment
variable selects the PostgreSQL adapter. If it is omitted, the server falls back to
the local JSON store at `.data/state.json`.

The control plane polls persisted deployments every 30 seconds and reconciles desired
versus observed state even when no browser is open. Override the interval for local
testing with `DEPLOYMENT_RECONCILE_INTERVAL_MS`; the value must be a positive number.

Compose sets `WORKSPACE_ROOT=/app/.data/workspaces`. Authored Project files and empty
directories are stored in that durable workspace volume rather than in PostgreSQL
control-plane state; compiled artifacts, runs, deployments, evidence, and telemetry
remain in their dedicated stores. Project paths are tenant/project scoped and
symlinks are rejected so a mounted source directory cannot escape its Project boundary.

Compose also starts a local Vault development server on port `8200`. Connection API
keys are written to Vault and represented in PostgreSQL only by an opaque reference.
The Compose Vault token is intentionally `dev-only-token`; this setup is for local
development and must not be used with production credentials.

To exercise the optional Temporal server and compiled worker locally, enable its
Compose profile and select the execution engine for the app:

```bash
EXECUTION_ENGINE=temporal docker compose --profile temporal up --build
```

This starts Temporal on `localhost:7233` and a separate `temporal-worker` container
using the compiled worker entrypoint. The default `docker compose up --build` path
still uses the lighter local executor. Temporal repository activities resolve a
run-scoped workspace instead of operating on the configured source checkout. Set
`TEMPORAL_REPOSITORY_RUN_ROOT` to a durable worker volume when restart recovery
must retain uncommitted run state; when unset, direct/local activity calls use a
temporary run directory. Repository mutation, patch, branch, commit, push,
pull-request, review, merge, and CI WorkUnits all use that same run-scoped
workspace and persist their activity lifecycle evidence. Configure
`GITHUB_REPOSITORY_OWNER`, `GITHUB_REPOSITORY_NAME`, and either `GITHUB_TOKEN` or
the Vault-backed `GITHUB_SECRET_REF` for the GitHub delivery adapters. The worker
also registers the provider-neutral OpenAI, Anthropic, Gemini, Ollama, and
OpenAI-compatible adapters; agent definitions are passed as immutable activity
input containing only provider configuration and Vault references. Provider
failures, unsupported capabilities, and undeclared tools fail closed without
exposing credentials.

Side-effecting WorkUnits may declare a deterministic compensation unit in their
envelope. If a later Temporal activity fails, completed units are compensated in
reverse order; each compensation gets its own stable node ID and idempotency key.
Set `requiresApproval: true` in the compensation config to pause for the normal
approval signal before the compensating activity runs:

```yaml
unit:
  kind: connector
  version: 1
  inputSchema: any
  outputSchema: any
  timeoutMs: 60000
  retryAttempts: 1
  idempotencyKey: repository-mutation:v1
  compensation:
    nodeType: repositoryMutation
    idempotencyKey: repository-mutation:compensate:v1
    config:
      capabilities: [repository.write]
      requiresApproval: true
      operations: []
```

PostgreSQL stores workflow and run control-plane state in `platform_state` and keeps
runtime logs, traces, and metrics in the indexed `observability_events` table. Legacy
JSON state events are moved into that table automatically on first startup. Runtime
observability retention is 48 hours by default; a cleanup pass runs at startup and
every 15 minutes and removes older records.

`GET /api/health` includes exporter health when OTLP is enabled (`healthy` or
`degraded`, failure count, and last success/error timestamps). Export errors remain
non-blocking for workflow execution but are therefore visible to operators.

The runtime uses the official OpenTelemetry API, SDKs, and async context manager
for parent-span propagation across asynchronous event/export boundaries. When an
OTLP or Phoenix endpoint is configured, the official SDK exporter is used by
default for traces, logs, and metrics. Set `OTEL_USE_SDK_EXPORTER=false` only for
compatibility with the legacy dependency-free OTLP bridge. SDK export failures are
non-blocking and remain visible through `/api/health`.

The Collector/Phoenix path has an opt-in Docker smoke test. It is skipped by
default (and whenever Docker is unavailable); run it with:

```bash
OTEL_DOCKER_SMOKE=1 npm run test:observability-smoke
```

The smoke test starts the observability Compose profile, checks app health and the
48-hour retention setting, posts a trace through the Collector, verifies Phoenix,
and removes the temporary containers when it finishes.

Temporal's restart boundary is also available as an opt-in Docker smoke test:

```bash
TEMPORAL_DOCKER_SMOKE=1 npm run test:temporal-smoke
```

It starts the Temporal profile, runs a deterministic wait workflow, restarts the
worker while the run is in flight, verifies terminal success and lifecycle
evidence, checks for duplicate completed WorkUnits, and tears down the profile.
The harness restores the seeded `workflow-agent-intake` definition after the run,
including when a smoke assertion fails.

Temporal agent activities accept declared tool calls through a worker-side
registry. The built-in `repo.*`, `workflow.code`, and `workflow.evaluate` tools
are bounded by the same WorkUnit and repository capability checks as ordinary
nodes; custom adapters can be supplied with
`configureTemporalToolExecutors`. Tool lifecycle records contain hashes and
stable call IDs, never raw arguments or results. Agent activities use a
no-automatic-retry boundary so an uncertain side effect fails closed instead of
being replayed by Temporal.

Deployments to `production`, `prod`, `preprod`, or `staging` are promotion-gated:
the action must reference a succeeded run for the same workflow that has both a
reviewable repository patch and a passing `repositoryCi` evidence record, plus a
separate approval bound to the exact deployment, artifact, and run. Request and
decide approvals with `POST /api/deployments/:id/approval`; list them with
`GET /api/deployment-approvals`. Approval records expire and cannot be reused for
another artifact or run. The deployment stores its verified run ID and continues
to record its release artifact, health, and transition history. Local environments
remain available for adapter and UI development without this promotion gate.

### Tenants and projects

The runtime is one shared installation that can host multiple isolated projects
(the product abstraction for a loop). A tenant owns projects; workflows, agent boxes,
connections, runs, proposals, and telemetry are scoped to a project. Existing local
data is migrated into `tenant-local` / `project-local`. The Studio sidebar provides
the loop switcher and a guided first-run checklist; API clients can select a scope
with `X-Tenant-ID` and `X-Project-ID` headers. Create a new project with
`POST /api/projects`, then clone a workflow into it with
`POST /api/projects/:projectId/workflows`.

### Phoenix traces (optional)

Phoenix is an optional local trace UI and OTLP receiver. The factory exports trace
events to Phoenix and can also fan out logs and metrics to any OTLP/HTTP endpoint.
Phoenix traces are deleted by the same 48-hour cleanup pass through Phoenix's trace
API; Phoenix is configured with a two-day default retention policy as a second safety
net. Phoenix's own scheduled policy cleanup can be less frequent, so keep the
factory cleanup process running when a strict 48-hour boundary matters.

Start the optional Phoenix container with Docker Desktop:

```bash
PHOENIX_ENDPOINT=http://phoenix:6006 \
PHOENIX_UI_URL=http://localhost:6006 \
  docker compose --profile observability up --build
```

Then open <http://localhost:6006>. To export all three signals to another OTLP/HTTP
backend, set `OTEL_EXPORTER_OTLP_ENDPOINT` as well. The app accepts the standard
comma-separated `OTEL_EXPORTER_OTLP_HEADERS` (`key=value`) for collector
authentication; header values are used only when constructing the exporter and
are never returned by the health API. The app accepts `OBSERVABILITY_RETENTION_HOURS`
(default `48`), but deployments should keep it at
48 hours when the product's short-retention policy is required. An external OTLP
backend must also be configured with its own 48-hour TTL; the factory cannot delete
records from arbitrary third-party storage.

If the generic backend should sit behind an OpenTelemetry Collector without
starting Phoenix, use the independent `observability-generic` profile. It accepts
traces, logs, and metrics, applies the same redaction boundary, and forwards all
three signals to `GENERIC_OTLP_ENDPOINT`:

```bash
GENERIC_OTLP_ENDPOINT=https://otel.example.com \
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector-generic:4318 \
  docker compose --profile observability-generic up --build
```

The generic backend owns its own retention policy; keep it at 48 hours when the
factory's short-retention contract is required.

For a local OpenTelemetry Collector boundary, point the app at the Collector's
OTLP/HTTP receiver and start the same profile:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
  docker compose --profile observability up --build
```

The `otel-collector` service accepts traces, logs, and metrics, applies a
defense-in-depth redaction processor, batches signals, and forwards traces to
Phoenix. Logs and metrics stay in the local Collector unless another exporter is
added to `otel-collector-config.yaml`. Keep the factory cleanup and Phoenix's
two-day policy enabled to preserve the 48-hour retention boundary.

`npm run check` runs type checking, tests, and the production web build.
`npm run check:bundle` enforces the browser asset budgets (650 KB JavaScript and
120 KB CSS). CI also builds the multi-stage production image and enforces a 900 MiB
uncompressed image budget with `npm run check:image`; that check is intentionally
separate because it requires a Docker daemon and remains optional for local setups
without Docker Desktop.

The credential-free optional-browser smoke suite runs with `npm run test:browser`. It
builds the production web app, starts a fresh isolated JSON-backed server, and checks
the compatibility authoring views, Observe tabs, and the Deployments operational card,
filters, links, and expansion affordances. CI installs
Chromium and runs this gate without Docker, PostgreSQL, Vault, model credentials, or
external services.

The default suite keeps the PostgreSQL restart probe opt-in so contributors do not
need a database daemon. To exercise the supported local persistence boundary, start
the Compose database and run the integration file explicitly:

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgresql://factory:factory@localhost:5432/factory \
  npm test -- --run src/storage/postgres-store.integration.test.ts
```

Vault boundary tests use a mocked local transport in the default suite; the Compose
Vault service is available for the real secret flow described above.

## Product workflow

```text
Define work units → validate contracts → simulate → version → run durably
       ↓                   ↓                 ↓          ↓
 agent boxes          deterministic code   approvals   correlated evidence
```

Work units exchange persisted outputs and schema metadata. Deterministic units are
appropriate for normalization, validation, transforms, and tests; agent units are
bounded by an agent box and may only use declared tools and connections. Agents
propose changes, while policy and human approval control promotion.

## Product surfaces

- **Projects:** terminal-native, file-backed source boundaries with AI proposal review,
  compiler diagnostics, and an advanced raw-source escape hatch.
- **Workflows:** operational graphs of versioned WorkUnit envelopes, with drill-down
  into execution contracts and a direct compile/run path.
- **Runs:** inspect status, cost, human touchpoints, node events, agent iterations,
  failures, and approval waits.
- **Connections:** manage non-secret connector metadata, environment bindings, scopes,
  health, and use.
- **Authoring proposals:** turn an intent or external-agent file bundle into a
  validated, approved, optimistically applied Project change and immutable artifact.
  The included goal planner is deterministic so local development needs no model key;
  the exact-file API is the seam for model-backed authoring.
- **Factory:** view throughput, success, cost, automation, human burden, and
  stage-level performance.

The optional browser client remains available for compatibility and observability,
but it is not required for Project authoring or workflow operation. The browser bundle
budget remains enforced in CI with `npm run check:bundle`.

The navigation, editor/artifact/deployment/run state machines, projection
boundaries, and Run preflight contract are documented in
[`docs/ide-state-model.md`](docs/ide-state-model.md).

Agent-loop nodes must reference an agent box declared in the workflow definition.
Each box versions its purpose, instructions, skills, tools, model route, input/output
schemas, connection and repository boundaries, budgets, termination rules, approval
gates, and telemetry redaction policy. Runtime events use a shared OpenTelemetry-style
envelope (logs, traces, and metrics) with OpenInference attributes for agent spans;
prompt and output capture is opt-in per agent.

Every node is also a versioned work unit with declared input/output schema names,
timeouts, retry count, and idempotency metadata. Deterministic code units use a
small allow-listed operation set (`uppercase`, `lowercase`, `trim`, and JSON
parse/stringify) and persist their outputs for downstream units; arbitrary code
execution remains a separate sandboxed integration boundary. Connector and
consumer units are always dispatched once per attempt, even if their envelope
declares a higher retry count, because an external side effect may have committed
before an error was observed.

## Architecture

```text
src/
  agents/          # Reviewable workflow proposal service
  connections/     # Credential-free connection metadata and health
  domain/          # Canonical schemas, graph validator, catalog, and types
  factory/         # Factory manifest and metrics
  observability/   # Correlated run event service
  runtime/         # Persistent local preview executor and approvals
  server/          # API-first Fastify control plane
  storage/         # JSON development and PostgreSQL control-plane persistence
  temporal/        # Durable Temporal workflow and activity worker
  web/             # React dashboard and workflow studio
```

The deployment shape is intentionally shared: one control-plane container serves
many projects, while PostgreSQL, Vault, Temporal workers, and optional Phoenix remain
separate services. Resource-heavy or untrusted work can later move to isolated worker
containers without creating a new platform container for every loop.

The local executor makes development self-contained and explicitly reports itself as
`local-durable-preview`. It checkpoints each unit to persistent state, supports
bounded agent loops and human approval/resume, and records correlated telemetry. For
an optional Temporal execution plane, run a Temporal service and start the worker
for the workflow version being served:

```bash
TEMPORAL_ADDRESS=localhost:7233 \
TEMPORAL_TASK_QUEUE_PREFIX=agentic-workflows \
TEMPORAL_WORKFLOW_VERSION=1 \
npm run worker
```

Run creation remains local unless explicitly switched. Set `EXECUTION_ENGINE=temporal`
to route the control plane through Temporal. The API persists the run and Temporal
identity before dispatch, uses a versioned queue (`agentic-workflows-v<workflowVersion>`),
and records searchable factory, workflow, version, environment, status, and
correlation attributes. The adapter reattaches to queued/running Temporal runs after
an API restart and observes the workflow result back into the same run record. Supply
`TEMPORAL_TASK_QUEUE` to the worker when you need an explicit queue name instead of
the prefix/version convention. During a rollout, `TEMPORAL_TASK_QUEUES` can contain
a comma-separated bounded set such as `agentic-workflows-v1,agentic-workflows-v2`;
one worker process will poll each queue so rollback can continue serving the prior
release while the new version is promoted.

Production workers and the API can connect to Temporal Cloud or a TLS-enabled
self-hosted cluster without putting certificate material in the image. Mount a
read-only secret volume and set `TEMPORAL_TLS_CERT_FILE`,
`TEMPORAL_TLS_KEY_FILE`, and (when needed) `TEMPORAL_TLS_CA_FILE` to the mounted
paths; set `TEMPORAL_TLS_SERVER_NAME` when the SNI name differs from the address.
`TEMPORAL_API_KEY` is supported for Temporal Cloud. The API and worker use the
same redacted connection settings, and startup fails closed when only one side of
the mTLS client certificate pair is configured.

The generic Temporal workflow pins a full definition, executes nondeterministic work
in activities, uses a signal for approvals, and applies activity retry policy. Docker
Compose provides PostgreSQL and a local Vault development server for an end-to-end
control-plane setup. When the worker has `DATABASE_URL` (or `DATA_FILE`) configured,
each activity writes retry-safe lifecycle evidence and correlated trace events to the
same platform store used by local execution. The workflow result also returns the
compact lifecycle summary; raw inputs and outputs remain outside telemetry and are
represented by hashes.

## Safety model

- Unknown node types, orphaned edges, cycles, duplicate IDs, trigger mismatches, and
  unbounded agent loops are rejected before execution.
- Agent output is a proposal against a known workflow version and cannot deploy.
- Workflow saves use optimistic version checks.
- Connections contain metadata and scopes; secret values are brokered through Vault
  and never enter workflow definitions, PostgreSQL state, or telemetry.
- HTTP activities enforce protocol checks, timeouts, and surfaced failures.
- Human approval, cancellation, costs, tool-like actions, and node transitions are
  auditable events.
