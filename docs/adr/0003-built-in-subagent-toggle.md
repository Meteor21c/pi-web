# Built-in sub-agent activation and extension precedence

MeteorAgent registers its integrated delegation tools for ordinary main sessions.
The composer supplies `subagentMode` on each new prompt. `auto` lets the parent
decide, `off` hides and blocks delegation tools, and `on` instructs the parent to
delegate at least one focused task and check the result. Steered and queued
messages share the running prompt's choice. Chat only, Plan, read-only mode, and
child sessions cannot delegate. Requests without a mode still use the legacy `builtInEnabled`
setting in `~/.pi/agent/agents/settings.json`.

An ordinary delegation can omit its profile. The built-in general-purpose
profile uses the parent's model by default and has access only to tools the
parent can use. Read-only parents cannot delegate write tools or create an
isolated worktree. Required delegation runs child calls in the foreground so
their results reach the parent before it continues. If the model completes
without delegating, the parent emits `subagent_required_unmet`. No extra request
is made to retry delegation.

The queue enforces the configured running limit per parent and an absolute
shared limit of 20. Extra jobs wait for a slot. Completed jobs do not consume
slots. Each child is saved immediately and the parent emits `subagent_status`
events when it queues, starts, and finishes. Reconnecting clients receive the
current state for active children.

The integrated tools take precedence over a recognized legacy `pi-subagents`
extension that registers `Agent`, `get_subagent_result`, or `steer_subagent`.
Unrelated extensions remain loaded. Existing child sessions remain readable
and already-running children can finish when a later prompt turns delegation off.
