# First-run onboarding

This is the shortest path from a fresh checkout to a running, observable loop.
The source files are the authoring boundary; PostgreSQL stores compiled and
runtime state, not editor buffers.

## 1. Start the local stack

From the repository root, start the control plane, PostgreSQL, and Vault:

```bash
docker compose up --build
```

Open [http://localhost:3100/#/studio](http://localhost:3100/#/studio). The
default local scope is `tenant-local` / `project-local`. For a lightweight
non-Docker preview, `npm run dev` starts the JSON-backed local server instead.

## 2. Create or import source files

In Workspace, use the Explorer selector to choose **Files**. Open a file tab and
edit the YAML; use **Apply YAML** to validate and compile it. The supported
project layout is:

```text
factory.yaml
workflows/*.workflow.yaml
agents/*.agent.yaml
units/*.unit.yaml
policies/*.policy.yaml
connections/*.connection.yaml
environments/*.environment.yaml
schemas/*.schema.json
canvas/*.canvas.yaml
```

The example project can be imported or used as a reference:

```bash
npm run factory -- validate examples/code-review-loop.yaml
npm run factory -- plan examples/code-review-loop.yaml
```

For a project that still only has the legacy aggregate workflow record, generate
the file-backed layout once through the API (the operation is idempotent):

```bash
curl -X POST http://localhost:3100/api/projects/project-local/migrate -H 'content-type: application/json' -d '{"dryRun":false}'
```

After migration, files are authoritative. **Canvas** and **Tree** are projections
of the same compiled resources; edits made through the compatibility Canvas are
written back to the corresponding source files.

## 3. Compile and run

Click **Apply YAML** (or the play-shaped **Run** action in the command bar). If a
workflow declares an input schema, the run dialog asks for JSON input. A dirty
buffer, compiler diagnostic, or invalid input blocks the run before any WorkUnit
executes. Run status and recent events appear in the bottom **Run Output** panel.

The equivalent compile operation is:

```bash
curl -X POST http://localhost:3100/api/projects/project-local/compile -H 'content-type: application/json' -d '{"environment":"local"}'
```

## 4. Observe the run

Open the **Observe** top-level tab, or select **Observe** beside a run in Run
Output. Observe correlates the run timeline with logs, traces, metrics, evidence,
and approval waits. Runtime telemetry is retained for 48 hours by default. The
optional Phoenix/Collector view is available with:

```bash
PHOENIX_ENDPOINT=http://phoenix:6006 PHOENIX_UI_URL=http://localhost:6006 docker compose --profile observability up --build
```

## 5. Create and operate a deployment

Deployments are managed on the **Deployments** top-level screen. The current
lean API flow creates a deployment from a compiled artifact; the screen then
provides Docker Desktop-style state, health evidence, recent runs, and Start,
Stop, Restart, and Observe actions:

```bash
ARTIFACT_ID=$(curl -s -X POST http://localhost:3100/api/projects/project-local/compile -H 'content-type: application/json' -d '{"environment":"local"}' | jq -r .id)
curl -X POST http://localhost:3100/api/deployments -H 'content-type: application/json' -d "{\"workflowId\":\"workflow-agent-intake\",\"environment\":\"local\",\"artifactId\":\"$ARTIFACT_ID\",\"trigger\":\"webhook\"}"
```

For protected environments (`production`, `prod`, `preprod`, or `staging`), a
succeeded run, passing repository-CI evidence, and an approval bound to the
exact artifact and run are required before promotion. Local deployments remain
available for development.

## 6. Restart safely

The app, PostgreSQL data, Vault state, workspace files, and artifacts are mounted
as Compose volumes. Restart the control plane without losing authored files:

```bash
docker compose restart app
```

Reload Workspace and the file tabs will be restored from the project workspace.
Use `docker compose down` only when you want to stop the stack; omit `-v` to keep
the persisted local data.

## Troubleshooting

- `GET /api/health` reports database, Vault, deployment reconciler, and exporter
  health.
- If a run is blocked, open **Problems** in the bottom panel and fix the source
  or input diagnostic before retrying.
- If Docker is not running, the Docker-gated Temporal and observability smoke
  tests are intentionally skipped. Start Docker Desktop and run
  `TEMPORAL_DOCKER_SMOKE=1 npm run test:temporal-smoke` or
  `OTEL_DOCKER_SMOKE=1 npm run test:observability-smoke` when those boundaries
  need verification.
