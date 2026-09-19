# Agent-Led Workflow Platform Plan

## 1. Product intent

Build an approachable, n8n-style workflow studio where people and agents can design,
run, inspect, and improve durable automations together. React and React Flow provide
the visual authoring surface; a typed workflow model is the source of truth; Temporal
provides durable execution; and a managed connection layer gives workflows safe,
auditable access to external systems.

The platform is not merely a canvas around an orchestration engine. It is an
agent-led development environment:

- People express outcomes, constraints, and approval boundaries.
- Agents propose workflow changes, connectors, tests, and operational responses.
- The platform validates, simulates, versions, and observes every change.
- Durable workers execute approved workflows with explicit identity, policy, and
  data boundaries.
- Runtime evidence feeds the next development loop without allowing an agent to
  silently rewrite production behavior.

## 2. Product principles

1. **One typed workflow definition:** the canvas, code view, API, version history,
   and Temporal compiler operate on the same canonical document.
2. **Agents propose; policy decides:** agent actions are constrained by permissions,
   budgets, approval gates, and deployment policy.
3. **Durability below, simplicity above:** users see understandable nodes, runs,
   failures, and recovery actions while Temporal handles replay, retries, timers,
   signals, and resumability.
4. **Observable by construction:** node transitions, model calls, connector calls,
   costs, artifacts, and human decisions emit correlated telemetry.
5. **Connections are managed resources:** credentials never live in workflow JSON;
   workflows reference scoped, policy-controlled connection bindings.
6. **Progressive disclosure:** a useful first workflow requires no orchestration
   expertise, while advanced users can inspect generated code and runtime semantics.
7. **Version everything:** definitions, prompts, policies, schemas, connections,
   tests, deployments, and run lineage are independently identifiable.
8. **Safe evolution:** draft, validate, simulate, review, deploy, observe, and
   promote rather than editing production in place.

## 3. Personas and primary jobs

| Persona | Primary job |
| --- | --- |
| Workflow builder | Compose reliable automations visually and understand failures |
| Domain owner | Define business outcomes, rules, approvals, and success measures |
| Agent developer | Add tools, prompts, evaluators, memory, and bounded agent loops |
| Platform engineer | Operate workers, tenancy, deployment, policy, and scale |
| Data/connection admin | Govern credentials, scopes, schemas, and data movement |
| Operator | Triage runs, retry safely, intervene, and measure service health |
| Auditor/security reviewer | Trace who changed, approved, accessed, and executed what |

## 4. Scope boundaries

### In scope

- Visual workflow authoring and a synchronized structured/code view
- Deterministic control-flow nodes and bounded agent-loop nodes
- Durable execution through Temporal
- Human tasks, approvals, pause/resume, signals, retries, schedules, and webhooks
- Connector catalog, credential lifecycle, schema discovery, and connection policy
- Run inspection, logs, traces, metrics, artifacts, cost, and evaluation results
- Agent-assisted creation, debugging, testing, optimization, and incident response
- Versioning, environments, promotion, rollback, audit, and role-based access
- APIs and SDKs for definitions, runs, connections, events, and extensions

### Deferred until the core is trustworthy

- Unbounded autonomous production changes
- Arbitrary third-party code execution without isolation and review
- A public connector marketplace
- Cross-region active/active control plane
- General-purpose model training or a proprietary vector database
- Billing and external multi-organization commerce

## 5. Canonical architecture

### 5.1 Control plane

- **React studio:** canvas, node palette, inspector, run view, connection manager,
  deployment view, agent chat, and administrative surfaces.
- **Platform API:** Fastify service exposing authenticated APIs and server-sent
  events or WebSockets for live run updates.
- **Definition service:** owns workflow documents, validation, version history,
  environments, drafts, diffs, and deployment records.
- **Compiler:** converts validated workflow graphs into a stable intermediate
  representation and then into Temporal workflow inputs/commands.
- **Agent control service:** plans changes and operations using a constrained tool
  API; records proposals, evidence, approvals, and outcomes.
- **Connection service:** owns connector manifests, credential references, scopes,
  schema snapshots, health, rotation, and policy checks.
- **Policy service:** evaluates authoring, deployment, runtime, data-access, budget,
  and approval rules.
- **Observability query service:** presents correlated run, node, connector, model,
  cost, and evaluation data.

### 5.2 Execution plane

- **Temporal workflows:** durable orchestration state, timers, signals, child
  workflows, cancellation, retries, and recovery semantics.
- **Activity workers:** isolated pools for connectors, model calls, transforms,
  code tasks, evaluation, and notifications.
- **Agent-loop runtime:** a bounded plan-act-observe-reflect loop implemented through
  Temporal activities and explicit continuation conditions.
- **Event ingestion:** normalizes runtime events into logs, metrics, traces, audit
  records, and product analytics.
- **Artifact store:** stores large inputs, outputs, tool results, evaluation evidence,
  and redacted snapshots outside Temporal history.
- **Secret broker:** resolves short-lived credentials at activity execution time and
  never exposes plaintext secrets to workflow definitions or model context.

### 5.3 Storage

- PostgreSQL for control-plane metadata, versions, deployments, RBAC, connection
  metadata, and audit indices.
- Temporal persistence for durable execution state.
- Object storage for artifacts and large payloads.
- OpenTelemetry-compatible telemetry backend for compact logs and metrics (trace export deferred).
- Optional pluggable retrieval store for agent memory, kept separate from the
  workflow source of truth.

## 6. Canonical workflow model

The workflow document should be JSON-serializable, schema-versioned, and validated
with Zod. A definition contains:

- Stable workflow ID, semantic version, schema version, owner, labels, and lifecycle
- Typed nodes with stable IDs, positions, configuration, input/output ports, retry
  policy, timeout, permissions, and observability options
- Typed edges with source/target ports and optional conditions
- Input, output, variable, secret-reference, and artifact schemas
- Trigger configuration for manual, schedule, webhook, event, or subworkflow starts
- Environment-independent connection requirements and environment-specific bindings
- Agent policy: models, tools, budgets, iteration limits, termination conditions,
  approval points, memory rules, and evaluator requirements
- Deployment policy and declared operational objectives

Initial node families:

| Family | Nodes |
| --- | --- |
| Triggers | Manual, schedule, webhook, event |
| Control | Branch, switch, merge, loop, wait, parallel, try/catch, subworkflow |
| Data | Map, filter, validate, transform, aggregate, template |
| Connections | HTTP, database, queue, storage, SaaS action |
| Agent | Prompt/model, tool call, planner, evaluator, bounded agent loop |
| Human | Approval, input task, escalation |
| Operations | Emit event, checkpoint, incident, notification |

The compiler must reject unreachable nodes, invalid port types, cycles without an
explicit loop construct, missing connection bindings, incompatible schemas, unsafe
payload sizes, and agent loops without budgets and termination conditions.

## 7. React dashboard information architecture

### 7.1 Global shell

- Organization/project/environment switcher
- Global search and command palette
- Notifications, active incidents, pending approvals, and agent activity
- Navigation for Workflows, Runs, Connections, Agents, Deployments, Observability,
  Audit, and Settings

### 7.2 Workflow studio

- React Flow canvas with keyboard-first editing, minimap, groups, comments, and
  collapsible subworkflows
- Searchable node palette generated from connector and node manifests
- Inspector with schema-aware forms, expressions, retries, timeouts, policies, and
  test fixtures
- Synchronized JSON/TypeScript-like structured view and visual diff
- Agent copilot that can propose a graph patch, explain it, generate tests, and
  identify required connections
- Validation panel showing errors, warnings, security concerns, and cost estimates
- Simulation panel with fixtures, mocked connections, breakpoints, and node outputs
- Version/deployment header showing draft state, environment drift, approvals, and
  rollback targets

### 7.3 Run and observability views

- Run list with state, duration, workflow version, trigger, environment, cost, owner,
  and searchable correlation fields
- Live graph overlay showing active, completed, retried, waiting, failed, cancelled,
  and compensated nodes
- Node timeline joining Temporal events with logs, traces, connector calls, model
  turns, token/cost data, artifacts, and human decisions
- Failure workbench with causal chain, retry safety, replay implications, redacted
  inputs/outputs, suggested remediation, and operator controls
- Fleet dashboards for throughput, latency, success, queue depth, retry rate, model
  cost, connector health, and SLOs

### 7.4 Connection manager

- Catalog of connector types and installed versions
- Connection creation with OAuth, API key, managed identity, database, or custom
  secret-broker flows
- Environment bindings, allowed workflows, scopes, data classification, residency,
  rate limits, and egress policy
- Test connection, discovered capabilities/schema, health, usage, expiration, and
  rotation status
- Impact analysis before changing or revoking a connection
- Immutable audit trail for access, configuration, testing, rotation, and use

## 8. Agent-led development model

### 8.1 Agent roles

- **Product agent:** turns an outcome into acceptance criteria and candidate workflow.
- **Builder agent:** proposes typed graph patches and connector requirements.
- **Test agent:** creates fixtures, mocks, invariants, failure cases, and replay tests.
- **Reviewer agent:** checks correctness, security, privacy, cost, and operability.
- **Operator agent:** summarizes failures and proposes bounded recovery actions.
- **Optimizer agent:** uses aggregate evidence to propose performance or cost changes.

Roles are policy profiles, not unrestricted personas. Each receives only the tools
and data required for its job.

### 8.2 Proposal lifecycle

1. Capture outcome, constraints, data classification, budget, and approval policy.
2. Produce a workflow proposal as a typed patch against a known version.
3. Explain assumptions, required connections, risks, and expected outcomes.
4. Validate schemas, graph semantics, permissions, budgets, and policies.
5. Generate and run simulations plus deterministic and agent-evaluation tests.
6. Present a reviewable graph/code diff with evidence.
7. Obtain required human or policy approvals.
8. Deploy immutably to a target environment.
9. Observe against declared objectives.
10. Create a new proposal from runtime evidence; never mutate the deployed version.

### 8.3 Runtime agent-loop contract

Every loop declares:

- Goal and success evaluator
- Allowed tools and connection scopes
- Maximum iterations, wall-clock duration, token/cost budget, and concurrency
- State/memory schema and retention
- Stop, fail, pause, and escalation conditions
- Human approval checkpoints
- Compensating actions for side effects
- Trace and artifact redaction policy

## 9. Orchestration semantics

- Use Temporal workflows only for deterministic coordination; perform I/O, model
  inference, and nondeterministic work in activities.
- Pin definition, prompt, connector, policy, and evaluator versions for each run.
- Use child workflows for subworkflows and long-lived agent tasks.
- Use signals/updates for human input, approvals, and operator interventions.
- Use search attributes for tenant, workflow, version, environment, status, and
  correlation identifiers.
- Apply activity-specific retry policies; side-effecting activities require
  idempotency keys and documented retry behavior.
- Keep large payloads in the artifact store and pass stable references through
  Temporal.
- Support cancellation, timeout, compensation, continue-as-new, and safe replay from
  the first production-capable release.

## 10. Observability model

Adopt a shared context envelope with tenant, project, environment, workflow, version,
deployment, run, node, attempt, Temporal workflow/run, trace, connection, agent, model,
and approval IDs.

Emit:

- **Metrics:** starts, completions, failures, latency, queue delay, retries, waits,
  connector calls, rate limits, model tokens/cost, evaluation score, and budget use.
- **Traces:** trigger through workflow/node/activity/tool/connector spans with causal
  links for async events and child workflows.
- **Logs:** structured, redacted events using stable error codes and correlation IDs.
- **Audit:** definition, policy, connection, deployment, approval, operator, and agent
  actions as append-only records.
- **Artifacts:** schema-tagged inputs, outputs, prompts, tool results, evaluations,
  and diagnostics with retention and access controls.

Initial service objectives:

- Control-plane availability and authoring latency
- Workflow start latency and successful completion rate
- Worker task queue latency
- Connector success and throttling rates
- Time to detect, understand, and safely recover failed runs
- Agent proposal acceptance, rollback, policy rejection, and escaped-defect rates

## 11. Data connection management

### 11.1 Connector manifest

Each connector publishes:

- Identity, version, publisher, runtime package, and integrity metadata
- Authentication methods and required scopes
- Actions/triggers with typed input/output schemas
- Side-effect, idempotency, pagination, webhook, and rate-limit characteristics
- Data classifications, supported regions, and network destinations
- Test/health operations and migration rules

### 11.2 Credential and policy flow

1. An administrator creates a connection through an approved authentication method.
2. Secrets are stored in an external vault or secret broker.
3. The platform stores only a reference plus non-secret metadata.
4. A connection is bound to environments and explicitly allowed workflows/actions.
5. At runtime, the worker requests short-lived access for the exact activity.
6. Policy evaluates tenant, workflow version, action, scope, data class, destination,
   budget, and approval state.
7. Usage and outcome are audited without leaking secret or sensitive payload data.

### 11.3 Required safeguards

- Envelope encryption and external vault integration
- OAuth refresh/rotation, expiration alerts, and revocation
- Least-privilege scopes and environment isolation
- SSRF/egress controls and destination allowlists
- Per-connection concurrency and rate limits
- Schema drift detection and compatibility warnings
- Payload size, retention, residency, and redaction policies
- Break-glass access with expiry and enhanced audit

## 12. Security and governance

- OIDC/SAML authentication and tenant-scoped RBAC
- Roles for viewer, builder, operator, connection admin, approver, and platform admin
- Attribute/policy checks for sensitive actions beyond static roles
- Workflow and connector package signing plus dependency provenance
- Sandboxed custom code with CPU, memory, time, filesystem, and network constraints
- Prompt-injection boundaries: external content is data, not authority; tool use is
  mediated by allowlists, schemas, and policy
- Secret and sensitive-data redaction before logs, traces, artifacts, or model context
- Deployment separation of duties and required approvals for protected environments
- Immutable audit export and configurable retention/deletion
- Threat modeling for control plane, workers, connectors, webhooks, agent tools,
  artifact access, and cross-tenant boundaries

## 13. Quality strategy

- Schema and graph-validation unit tests
- Compiler golden tests from workflow document to intermediate representation
- Temporal replay tests for every released workflow implementation
- Connector contract tests and recorded/mocked fixtures
- Integration tests using Temporal's test environment and ephemeral dependencies
- UI component and interaction tests for canvas editing, diffs, and run overlays
- End-to-end golden paths for build, simulate, deploy, run, pause, approve, fail,
  retry, compensate, and rollback
- Agent evaluations for proposal validity, policy compliance, tool selection,
  termination, cost, and explanation grounding
- Load and soak tests for event ingestion, run streaming, task queues, and high-cardinality
  observability
- Failure injection for worker loss, duplicate delivery, throttling, expired
  credentials, schema drift, model timeout, and approval timeout

## 14. Delivery roadmap with outcome gates

### Phase 0: Contracts and walking skeleton

**Outcome:** one versioned workflow can be authored as JSON, validated, compiled, run
locally through Temporal, and inspected through correlated events.

Deliver:

- Repository boundaries and local development stack
- Workflow schema, graph validator, and migration convention
- Minimal API, Temporal worker, event model, and React shell
- Manual trigger plus action, branch, wait, and output nodes
- One mock connector and one real HTTP connector
- CI checks, replay test, threat model, and architecture decisions

Gate:

- A fresh checkout runs the golden workflow deterministically.
- Restarting API or worker does not lose execution state.
- Every node state is visible and correlated.

### Phase 1: Fundamental visual workflow MVP

**Outcome:** a builder can visually create, test, version, and run a useful workflow
without editing JSON.

Deliver:

- React Flow canvas, palette, inspector, edge validation, autosave, and undo/redo
- Manual, schedule, webhook, data transform, condition, HTTP, wait, and notification
  nodes
- Draft/version model and visual diff
- Simulation with fixtures and mocked connector outputs
- Run list, live graph overlay, node timeline, logs, and artifacts
- Basic local authentication and project/environment model

Gate:

- A non-developer completes a documented workflow scenario.
- Visual save/load is lossless against the canonical definition.
- Invalid graphs cannot deploy.

### Phase 2: Durable orchestration and operations

**Outcome:** workflows safely handle long waits, failures, human decisions, and
operational recovery.

Deliver:

- Retry/timeout/idempotency configuration
- Parallel, loop, subworkflow, human approval, cancellation, and compensation
- Operator actions for retry, resume, cancel, and approved input
- Deployment records, environment promotion, rollback, and version pinning
- Search attributes, fleet dashboards, alerts, and initial SLOs
- Artifact storage and payload offloading

Gate:

- Chaos tests prove recovery after worker/API restarts.
- Replay tests cover all released orchestration paths.
- Operators can identify and safely act on a failed node from one view.

### Phase 3: Managed connections

**Outcome:** administrators can provide reusable connections without exposing
credentials to builders, definitions, logs, or agents.

Deliver:

- Connector SDK and manifest registry
- Vault-backed secrets, OAuth lifecycle, connection bindings, and scoped runtime
  credential resolution
- Connection catalog, setup UI, health tests, usage, rotation, and impact analysis
- HTTP, PostgreSQL, queue, object storage, and two representative SaaS connectors
- Egress, data-classification, rate-limit, and environment policies

Gate:

- Secret scanning confirms definitions and telemetry contain no credentials.
- Revocation and rotation work without editing workflow definitions.
- Every connection use is attributable to a workflow node and identity.

### Phase 4: Agent-assisted development

**Outcome:** an agent can turn a bounded outcome into a reviewable, tested workflow
proposal.

Deliver:

- Agent tool API for catalog search, definition read/patch, validation, simulation,
  test generation, and documentation
- Product, builder, test, and reviewer policy profiles
- Proposal/diff/evidence UI and approval workflow
- Prompt, model, tool, policy, and evaluator versioning
- Offline evaluation suite and cost estimation

Gate:

- Agent output is always a typed proposal against a known base version.
- No agent can deploy or access a connection outside policy.
- Benchmark proposals meet validity, test, security, and cost thresholds.

### Phase 5: Governed runtime agents

**Outcome:** production workflows can use bounded agent loops with explicit budgets,
termination, approvals, and complete evidence.

Deliver:

- Agent-loop node and Temporal child-workflow runtime
- Tool registry, memory adapters, evaluator nodes, and human escalation
- Iteration/time/token/cost/concurrency budgets
- Model routing and fallback policy
- Agent turn timeline, tool-call evidence, evaluation scores, and cost telemetry
- Injection defenses and adversarial evaluation suite

Gate:

- Every loop terminates, pauses, or escalates within declared bounds.
- Side effects are idempotent or compensatable.
- Operators can reconstruct why each tool action occurred.

### Phase 6: Closed-loop operations and scale

**Outcome:** runtime evidence continuously produces safe improvement proposals across
multiple teams and environments.

Deliver:

- Operator and optimizer agents with read-first, approval-gated tools
- Incident correlation, causal summaries, remediation proposals, and runbooks
- Canary deployment, progressive rollout, automated rollback signals, and drift
  detection
- Multi-tenant isolation, worker pools, quotas, retention, and regional controls
- Platform and connector extension lifecycle

Gate:

- Improvement proposals are evidence-linked and never self-promote in protected
  environments.
- Tenant isolation and scale targets pass independent testing.
- SLO, cost, and incident metrics improve without higher change-failure rate.

## 15. Initial implementation slices

Build vertical slices rather than completing one layer at a time:

1. **Hello durable workflow:** definition -> validation -> compile -> Temporal run ->
   live UI state.
2. **Useful integration:** webhook -> validate -> HTTP connection -> branch ->
   notification, including secret-safe connection binding.
3. **Human-in-the-loop:** long wait -> approval signal -> continue/reject, with audit.
4. **Operational failure:** injected connector failure -> retry -> operator diagnosis ->
   safe recovery.
5. **Agent-authored draft:** outcome -> proposed graph patch -> tests -> simulation ->
   human approval.
6. **Bounded runtime agent:** goal -> tool call -> evaluator -> stop/escalate, with
   budget and complete trace.

## 16. Suggested repository structure

```text
N8N/
  src/
    domain/          # Workflow schemas, graph rules, shared contracts
    compiler/        # Canonical graph to executable IR
    temporal/        # Workflows, activities, workers, replay tests
    connections/     # Manifests, bindings, secret broker, connector runtime
    agents/          # Proposal and bounded runtime-agent services
    observability/   # Event envelope, OTel, audit, query projections
    policy/          # Authorization and policy evaluation
    server/          # Fastify APIs and streaming endpoints
    web/             # React application and feature modules
  packages/
    connector-sdk/
    workflow-sdk/
    ui-components/
  scripts/
  tests/
    integration/
    e2e/
    replay/
    evaluations/
```

Enforce dependency direction: UI/API adapters depend on application services;
application services depend on domain contracts; Temporal, storage, model, and
connector implementations sit behind interfaces.

## 17. Decisions to record before scaling implementation

- Canonical workflow schema and migration compatibility policy
- Compiler strategy: generic interpreter workflow versus generated workflow code
- Definition/version/deployment identity and immutability rules
- Tenant/project/environment authorization model
- Event envelope and telemetry retention/redaction rules
- Connector isolation and package trust model
- Secret broker and short-lived credential strategy
- Custom code sandbox technology
- Agent proposal patch format and approval semantics
- Artifact storage, encryption, and payload thresholds
- Supported compensation guarantees and operator action semantics

## 18. Fundamental release definition

The fundamental release is complete when a user can visually build a versioned
workflow, bind an administrator-managed connection, simulate it, deploy it to an
environment, execute it durably, follow every node live, inspect a redacted causal
timeline, recover a failure safely, and ask an agent to propose a tested improvement
without granting that agent implicit production or credential access.
