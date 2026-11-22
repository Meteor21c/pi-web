# Built-in sub-agent activation and extension precedence

MeteorAgent registers its integrated delegation tools for ordinary main sessions.
The composer supplies `subagentMode` on each new prompt. At High, XHigh, or Max
reasoning, `auto` requires the parent to delegate at least one focused task and
review the result. The parent chooses how many tasks to delegate within the
configured concurrency limit. At other levels, including provider Auto, the
parent decides whether to delegate. `off` hides and blocks delegation tools.
`on` requires delegation at any reasoning level.

Steered and queued messages share the running prompt's choice. Chat only, Plan,
read-only mode, and child sessions cannot delegate. Requests without a mode
use the legacy `builtInEnabled` setting in `~/.pi/agent/agents/settings.json` to
determine whether Auto delegation is available.

An ordinary delegation can omit its profile. The built-in general-purpose
profile uses the parent's model by default and has access only to tools the
parent can use. Required delegation runs child calls in the foreground so their
results reach the parent before it continues.

If a regular turn would finish without a successful launch under Auto with
high reasoning, the parent gets one automatic retry within that turn. The
parent emits `subagent_required_unmet` when it finishes without launching a
child despite a delegation requirement.

The queue enforces the configured running limit per parent and an absolute
shared limit of 20. Extra jobs wait for a slot. Completed jobs do not consume
slots. Each child is saved immediately and the parent emits `subagent_status`
events when it queues, starts, and finishes. Reconnecting clients receive the
current state for active children.

The integrated tools take precedence over a recognized legacy `pi-subagents`
extension that registers `Agent`, `get_subagent_result`, or `steer_subagent`.
Unrelated extensions remain loaded. Existing child sessions remain readable
and already-running children can finish when a later prompt turns delegation off.
