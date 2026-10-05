# Agent Execution Continuity

This note describes a provider-neutral runtime layer for long-running agent work.

It is intended for systems that already know what work should happen, but need that work to continue safely across models, local/cloud executors, devices, reconnects, quota windows, retries, and temporary failures.

The central distinction is:

> **Runtime availability is not work truth.**

A model going offline, a laptop sleeping, a transport disconnecting, or a quota window exhausting may interrupt an execution attempt. None of those facts, by themselves, prove that the underlying work is cancelled, failed, unauthorized, accepted, paid, or complete.

## Why this exists

Agent products increasingly span chat clients, local desktop executors, cloud workers, mobile controllers, CLIs, repositories, tool servers, external APIs, and finite compute budgets.

When each surface maintains its own implicit state machine, users become the synchronization layer.

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

### Task

A bounded unit of work under an objective.

### ExecutionAttempt

One executor trying to perform the task. The task must survive replacement of the execution attempt.

### ExecutionLease

An executor may hold a temporary lease without owning task identity.

### ResourceBudget

Finite compute or other runtime resources are explicit task dependencies rather than hidden client state.

### Approval

Consequential transitions use a durable approval lifecycle.

### Artifact

Files, patches, commits, pull requests, tests, reports, screenshots, receipts, and approval records attach directly to the task without expanding what they prove.

### Event

The runtime is reconstructible from append-only events.

## Core invariants

### Execution failure is not work failure

```text
executor blocked != task failed
executor completed != result accepted
agent output != proof
artifact exists != artifact verified
payment exists != settlement
```

### Executor availability is not authority

A provider becoming available does not grant permission to use it. A provider becoming unavailable does not automatically revoke the task.

Any replacement executor must satisfy the same authority, privacy, cost, and capability constraints.

### The user is not the default recovery mechanism

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

### "Needs user" is explicit

Every blocker should answer whether human intervention is genuinely required and why.

### Blockers are typed

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

### Commands are idempotent

Send, stop, resume, retry, and approve should have durable command IDs and idempotency keys.

Retries must not duplicate work, spending, approvals, or external actions.

### Context is portable

Do not require the entire historical chat to continue execution.

Use a typed context capsule carrying the goal, constraints, verified facts, completed steps, artifacts, blockers, approvals, and state version.

Conversation history remains provenance, not the only operational memory.

### Authority does not widen on recovery

Recovery policy can authorize safe operational actions without authorizing new consequences.

## Provider portability

The task should survive replacement of the model or runtime:

```text
executor A unavailable
-> checkpoint typed state
-> evaluate replacement against policy
-> executor B receives same bounded task context
-> continue same task_id
```

The replacement executor inherits no hidden privilege.

## Coordination performance

Measure separately:

- interaction latency: user command -> durable acknowledgement;
- coordination latency: accepted intent -> eligible executor starts useful work;
- execution latency: executor start -> bounded output/artifact.

A long-running task can feel reliable if interaction and coordination are fast and state is legible. A short task can feel broken if the user cannot tell whether it started.

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
