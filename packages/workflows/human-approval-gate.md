# Human Approval Gate

Use this gate before any downstream live action.

## Required checks

- Who is approving?
- What exact action is approved?
- What system will be touched?
- Can the action be reversed?
- What proof will be logged?
- What is the rollback path?

The public kernel does not execute live actions. It only prepares reviewable proposals.
