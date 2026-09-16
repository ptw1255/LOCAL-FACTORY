# Agentic Workflow Factory

Agentic Workflow Factory is a visual, API-first runtime for composing deterministic
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

## Status

The repository is an actively developed MVP. The current release includes the visual
Studio, versioned workflows and agent boxes, a local durable executor, Temporal
workflow definitions, PostgreSQL persistence, Vault-backed local secrets, standardized
OpenTelemetry/OpenInference-style telemetry, bounded proposals, and factory metrics.
The model-provider and repository-execution adapters are intentionally explicit next
steps rather than hidden capabilities.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` requests to the Fastify server on
port 3100. Without `DATABASE_URL`, runtime state is stored in `.data/state.json`.
Without Vault configuration, credential writes are rejected rather than persisted.

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

With `pull-on-start`, the app checks `/api/tags` during startup and pulls the model
when it is missing. It retries provisioning on the first run if Ollama was not yet
ready. `never` (the default) requires the model to already exist; `baked` is reserved
for preloaded model volumes. The runtime records an `llm.completed` trace for each
Ollama call and preserves the agent's declared input/output capture and network
policies.

### Bounded model routing

An agent can declare a bounded list of provider routes. `fallback` tries each route in
order and records route failures/selections in the same run trace; `single` uses only
the first route. Each route may override the provider, model, endpoint, or Vault
secret reference while inheriting the rest of the agent policy:

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
```

Routing is bounded to eight declared attempts and does not expose API keys in YAML,
PostgreSQL, or telemetry. The built-in routes are OpenAI and Ollama; additional
provider adapters can implement the same provider-neutral contract.

### OpenAI Responses API

Hosted agent boxes use the provider-neutral runtime with a server-side Responses API
official OpenAI Node SDK Responses adapter. Keep the key in Vault and reference only its connection path from YAML:

```yaml
model:
  provider: openai
  model: gpt-5-mini
  secretRef: connections/openai
  streaming: true
```

For local development, start Vault and write the secret before running the server:

```bash
export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=dev-root-token
vault kv put secret/connections/openai value="$OPENAI_API_KEY"
npm run server
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

### Local repository checks

Set `REPOSITORY_WORKSPACE` to expose the bounded repository API. Only `npm test`,
`npm run typecheck`, and `npm run build` can execute; arbitrary commands and paths
outside the configured root are rejected:

```bash
REPOSITORY_WORKSPACE=/path/to/repository npm run server
```

Use `GET /api/repository` to inspect the workspace and `POST /api/repository/check`
with `{ "command": "npm test" }` to receive exit code, duration, timeout state, and
truncated output evidence.

If GitHub integration is configured with `GITHUB_TOKEN`,
`GITHUB_REPOSITORY_OWNER`, and `GITHUB_REPOSITORY_NAME`, the bounded
`POST /api/repository/pull-request` endpoint can open a reviewable PR from an
already-created branch. The token is used only in the Authorization header and is
never included in request payloads or telemetry.

Useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run demo
npm run server
```

### YAML-first authoring

Project YAML is the source of truth for loop topology, agent boxes, work-unit
contracts, and runtime policy. The database stores the compiled runtime index,
immutable versions, run state, and 48-hour telemetry; it is not the authoring
surface. Keep YAML in Git, review it like code, and use the Studio primarily to
inspect the operational tree or open the legacy canvas when visual editing helps.

The repository includes a complete example at
[`examples/code-review-loop.yaml`](examples/code-review-loop.yaml). Validate or
inspect any project definition with the local CLI:

```bash
npm run factory -- validate examples/code-review-loop.yaml
npm run factory -- plan examples/code-review-loop.yaml
npm run factory -- tree examples/code-review-loop.yaml
npm run factory -- run examples/code-review-loop.yaml workflow-code-review
```

The control plane exposes the same workflow for automation and GitOps tooling:

```text
GET  /api/projects/:projectId/declarative.yaml  # export the project
POST /api/projects/:projectId/declarative       # replace project config from { source }
```

Imports are validated and compiled through the same canonical schemas used by the
runtime. A failed import leaves the existing project configuration untouched.

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

Compose also starts a local Vault development server on port `8200`. Connection API
keys are written to Vault and represented in PostgreSQL only by an opaque reference.
The Compose Vault token is intentionally `dev-only-token`; this setup is for local
development and must not be used with production credentials.

PostgreSQL stores workflow and run control-plane state in `platform_state` and keeps
runtime logs, traces, and metrics in the indexed `observability_events` table. Legacy
JSON state events are moved into that table automatically on first startup. Runtime
observability retention is 48 hours by default; a cleanup pass runs at startup and
every 15 minutes and removes older records.

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
backend, set `OTEL_EXPORTER_OTLP_ENDPOINT` as well. The app accepts
`OBSERVABILITY_RETENTION_HOURS` (default `48`), but deployments should keep it at
48 hours when the product's short-retention policy is required. An external OTLP
backend must also be configured with its own 48-hour TTL; the factory cannot delete
records from arbitrary third-party storage.

`npm run check` runs type checking, tests, and the production web build.

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

- **Studio:** IDE-style declarative workspace with a project explorer, editable YAML
  source, compile/apply diagnostics, operational tree, agent-box inspection, and an
  optional React Flow canvas for compatibility editing.
- **Runs:** inspect status, cost, human touchpoints, node events, agent iterations,
  failures, and approval waits.
- **Connections:** manage non-secret connector metadata, environment bindings, scopes,
  health, and use.
- **Agent proposals:** turn an outcome into a reviewable, bounded workflow proposal.
  The included planner is deterministic so the repository runs without external AI
  credentials; its service boundary can be replaced with a model-backed planner.
- **Factory:** view throughput, success, cost, automation, human burden, and
  stage-level performance.

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
execution remains a separate sandboxed integration boundary.

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
a Temporal deployment, run a Temporal service and start:

```bash
TEMPORAL_ADDRESS=localhost:7233 npm run worker
```

The generic Temporal workflow pins a full definition, executes nondeterministic work
in activities, uses a signal for approvals, and applies activity retry policy. Docker
Compose provides PostgreSQL and a local Vault development server for an end-to-end
control-plane setup.

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
