# FACTORY agent onboarding

FACTORY now ships a provider-neutral onboarding contract for agents that create,
edit, or operate Projects and Workflows. The canonical built-in text is exposed
locally through:

```text
GET /api/factory/agent-onboarding
```

It includes a version and SHA-256 digest so an authoring or control agent can
pin the exact guide it used. The terminal can print the same contract:

```bash
factory guide
```

The guide tells an agent to:

- establish tenant, Project, Workflow, run, and environment scope;
- read `factory.yaml`, then applicable `AGENTS.md` files, then only relevant
  resource files;
- treat Workflows as graphs of versioned WorkUnit envelopes;
- keep deterministic preparation and publishing separate from bounded agent
  reasoning;
- preserve stable resource identity and use references instead of copied
  definitions or credentials;
- inspect, propose, validate, approve, apply, compile, run, and inspect
  evidence in that order;
- keep secrets out of source, prompts, telemetry, artifacts, commits, and pull
  requests; and
- stop on stale hashes, missing context, failed checks, or uncertain external
  side effects instead of silently retrying.

This guide is a local control-plane contract. FACTORY does not automatically
send it to an external model provider. An integration or workflow may
explicitly fetch and include the pinned guide when its own data and prompt
policy permits it. Project-specific `AGENTS.md` files remain additional local
guidance and never grant authorization beyond the agent envelope.
