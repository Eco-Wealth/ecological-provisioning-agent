# Agent Execution Continuity

This note describes a provider-neutral runtime layer for long-running agent work.

It is intended for systems that already know what work should happen, but need that work to continue safely across models, local/cloud executors, devices, reconnects, quota windows, retries, and temporary failures.

The central distinction is:

> **Runtime availability is not work truth.**

A model going offline, a laptop sleeping, a transport disconnecting, or a quota window exhausting may interrupt an execution attempt. None of those facts, by themselves, prove that the underlying work is cancelled, failed, unauthorized, accepted, paid, or complete.

## Why this exists

Agent products increasingly span:

- chat clients;
- local desktop executors;
- cloud workers;
- mobile controllers;
- CLIs;
- repositories;
- tool servers;
- external APIs;
- finite compute budgets.

When each surface maintains its own implicit state machine, users become the synchronization layer.

That creates a poor failure pattern:

```text
agent finds a problem
-> reports it
-> user switches surface
-> user restarts/retries
-> user reconciles stale state
-> user decides whether the task is still alive
```

A better system absorbs ordinary runtime complexity and escalates only when human authority, money, credentials, irreversible action, or genuine judgment is required.

## Minimal runtime model

A useful implementation can be built from a few objects:

```text
Objective
Task
ExecutionAttempt
ExecutionLease
ResourceBudget
Approval
Artifact
Event
```

### Objective

The durable outcome the user wants.

```json
{
  "objective_id": "obj_...",
  "title": "...",
  "intent": "...",
  "status": "active|paused|completed|cancelled"
}
```

### Task

A bounded unit of work under an objective.

```json
{
  "task_id": "task_...",
  "objective_id": "obj_...",
  "state": "planned|queued|executing|waiting|blocked|needs_approval|completed|verified|cancelled",
  "blocker": null
}
```

### ExecutionAttempt

One executor trying to perform the task.

```json
{
  "execution_id": "exec_...",
  "task_id": "task_...",
  "executor": {
    "kind": "agent|human|hybrid|robot",
    "provider": "openai|anthropic|local|other",
    "model": "optional",
    "location": "local|cloud|field|other"
  },
  "state": "queued|executing|waiting|blocked|completed|abandoned",
  "blocker": null,
  "needs_user": false,
  "artifacts": []
}
```

The task must survive replacement of the execution attempt.

### ExecutionLease

A task may be assigned to one executor without making that executor the owner of the task.

```json
{
  "execution_id": "exec_...",
  "executor_id": "host_...",
  "lease_state": "assigned|running|lost|released",
  "heartbeat_at": "...",
  "lease_expires_at": "..."
}
```

### ResourceBudget

Finite compute or other runtime resources should be explicit dependencies.

```json
{
  "resource_id": "model_allowance",
  "scope": "account",
  "state": "available|low|exhausted",
  "blocking_tasks": ["task_..."],
  "remediation": [
    {
      "type": "reset",
      "available": true,
      "requires_confirmation": true
    }
  ]
}
```

### Approval

Use one lifecycle for consequential transitions.

```json
{
  "approval_id": "appr_...",
  "task_id": "task_...",
  "action": "consume_finite_resource",
  "state": "pending|approved|denied|expired|consumed",
  "risk_class": "resource|external_action|financial|deployment|identity"
}
```

### Artifact

Artifacts should attach directly to the task:

- file;
- patch;
- commit;
- pull request;
- test result;
- report;
- screenshot;
- receipt;
- approval record.

A reference to an artifact does not expand what it proves.

### Event

The runtime should be reconstructible from append-only events.

```jsonl
{"seq":1,"type":"task.created","task_id":"task_1"}
{"seq":2,"type":"execution.assigned","execution_id":"exec_1","executor_id":"host_1"}
{"seq":3,"type":"execution.started","execution_id":"exec_1"}
{"seq":4,"type":"artifact.recorded","kind":"pull_request","ref":"#123"}
{"seq":5,"type":"resource.exhausted","resource":"model_allowance"}
{"seq":6,"type":"execution.blocked","reason":"compute_exhausted","needs_user":true}
{"seq":7,"type":"approval.available","action":"consume_finite_resource"}
{"seq":8,"type":"approval.approved","client":"mobile"}
{"seq":9,"type":"resource.restored","resource":"model_allowance"}
{"seq":10,"type":"execution.resumed","execution_id":"exec_1"}
```

## Core invariants

### 1. Execution failure is not work failure

Keep these distinct:

```text
executor blocked != task failed
executor completed != result accepted
agent output != proof
artifact exists != artifact verified
payment exists != settlement
```

### 2. Executor availability is not authority

A provider becoming available does not grant permission to use it.

A provider becoming unavailable does not automatically revoke the task.

Any replacement executor must satisfy the same authority, privacy, cost, and capability constraints.

### 3. The user is not the default recovery mechanism

Safe recovery order:

```text
1. reconcile stale state
2. retry bounded transient/idempotent failures
3. reconnect transport
4. rerun safe deterministic checks
5. renew/replace execution lease
6. choose an equivalent executor within policy
7. preserve task identity and degrade gracefully
8. collapse remaining symptoms into one typed blocker
9. escalate only when the human is actually required
```

A system problem does not automatically become a user task.

### 4. "Needs user" is explicit

Every blocker should answer this directly.

```json
{
  "needs_user": false,
  "reason": null
}
```

or:

```json
{
  "needs_user": true,
  "reason": "approval_required",
  "action": "consume_finite_resource",
  "why_only_user_can_do_this": "explicit consent required"
}
```

### 5. Blockers are typed

Examples:

```text
compute_exhausted
approval_required
executor_offline
transport_disconnected
repository_conflict
check_failed
policy_refusal
external_dependency
auth_expired
network_unreachable
rate_limited
credential_missing
user_paused
```

A typed blocker should map to a typed next action.

### 6. Commands are idempotent

Send, stop, resume, retry, and approve should have durable IDs and idempotency keys.

```json
{
  "command_id": "cmd_...",
  "task_id": "task_...",
  "type": "resume",
  "idempotency_key": "...",
  "accepted_at": "..."
}
```

Retries must not duplicate work, spending, approvals, or external actions.

### 7. Context is portable

Do not require the entire historical chat to continue execution.

Use a typed context capsule:

```json
{
  "task_id": "task_...",
  "goal": "...",
  "constraints": [],
  "verified_facts": [],
  "completed_steps": [],
  "artifacts": [],
  "blockers": [],
  "pending_approvals": [],
  "state_version": 1
}
```

Conversation history remains provenance, not the only operational memory.

### 8. Authority does not widen on recovery

A recovery policy can authorize safe operational actions without authorizing new consequences.

```json
{
  "retry_transient": true,
  "refresh_stale_state": true,
  "reconnect_transport": true,
  "rerun_idempotent_checks": true,
  "switch_equivalent_executor": true,
  "use_paid_compute": false,
  "deploy": false,
  "external_actions": false,
  "move_money": false
}
```

## Provider portability

The task should survive replacement of the model or runtime:

```text
executor A unavailable
-> checkpoint typed state
-> evaluate replacement against policy
-> executor B receives same bounded task context
-> continue same task_id
```

The replacement executor should inherit:

- goal;
- constraints;
- verified facts;
- artifacts;
- completed steps;
- blockers;
- pending approvals.

It should not inherit hidden privilege.

## Coordination performance

Measure at least three different kinds of latency:

### Interaction latency

User command -> durable acknowledgement.

### Coordination latency

Accepted intent -> eligible executor starts useful work.

### Execution latency

Executor start -> bounded output/artifact.

A long-running task can feel reliable if interaction and coordination are fast and state is legible.

A short task can feel broken if the user cannot tell whether it started.

## Operator-friction metrics

Useful measures include:

- user interventions per completed task;
- unnecessary user interventions;
- percentage of blockers auto-recovered;
- percentage of escalations that truly required user authority/judgment;
- repeated requests for already-known information;
- manual recovery commands;
- number of product surfaces required to finish one objective;
- duplicate task/execution rate after reconnect;
- blocker -> understandable next action latency;
- recovery -> resume latency.

Desired direction:

```text
1 objective
0-1 meaningful approvals
0 manual infrastructure commands
0 cross-surface scavenger hunts
1 verified result
```

## Completion-first orchestration

Bad default:

```text
check failed
-> stop
-> report failure
-> wait for user
```

Better default:

```text
check failed
-> classify
-> repair if within authority
-> rerun verification
-> continue
-> report useful final state
```

Only after bounded recovery is exhausted should a recoverable technical condition become a user-visible blocker.

## Product principle

The implementation can remain distributed.

The product model should not force the user to think in terms of those distributed components.

A good system should always be able to answer:

```text
What am I trying to accomplish?
What is running?
Where is it running?
What resource is it using?
What changed?
What is blocked?
Why is it blocked?
Can the system recover by itself?
If not, what exactly needs me?
What artifacts exist?
What remains?
```

## Related public discussion

A public OpenAI Codex issue raised the same class of problem inside one provider's product surfaces:

https://github.com/openai/codex/issues/50998

This document is provider-neutral. It does not depend on OpenAI, Codex, or any specific agent vendor.

The portable lesson is:

> **One durable objective, one authoritative task state, replaceable executors, explicit authority, typed blockers, and minimal unnecessary human interruption.**
