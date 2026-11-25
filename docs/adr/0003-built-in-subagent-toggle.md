# Built-in sub-agent activation and extension precedence

MeteorAgent registers its integrated delegation tools for ordinary main sessions.
The composer supplies `subagentMode` on each new prompt. At High, XHigh, or Max
reasoning, `auto` asks the parent to identify independent work early and
delegate it when that helps. At other levels, including provider Auto, the
parent delegates as needed. `off` hides and blocks delegation tools. `on`
requires at least one delegated task at any reasoning level. The parent
chooses how many tasks to delegate within the configured concurrency limit.

Steered and queued messages share the running prompt's choice. Chat only, Plan,
read-only mode, and child sessions cannot delegate. Requests without a mode
use the legacy `builtInEnabled` setting in `~/.pi/agent/agents/settings.json` to
determine whether Auto delegation is available.

In an existing Chat-only or read-only conversation, choosing Auto or On in the
composer asks whether to enable Full tools for that conversation. The user's
default for new conversations is retained. Plan mode continues to restrict
delegation. The approval selector records its own preference, which the runtime
applies only on eligible tasks.

An ordinary delegation can omit its profile. Built-in profiles default to
background execution, use the parent's model by default, and have access only
to tools the parent can use. The parent can work on another part of the task
as soon as `Agent` returns. It can wait for a specific dependency with
`get_subagent_result` or request foreground execution for a serial step.

Before settling, a parent run gathers unread child results into one hidden
continuation. The Goal report requires the parent to receive the results before
recording completion. Stop or an interrupted run cancels its queued and running
children. A forced run that finishes without dispatching emits
`subagent_required_unmet`.

The queue enforces the configured running limit per parent and an absolute
shared limit of 20. Extra jobs wait for a slot. Completed jobs do not consume
slots. Each child is saved immediately and the parent emits `subagent_status`
events when it queues, starts, and finishes. Reconnecting clients receive the
current state for active children.

The integrated tools take precedence over a recognized legacy `pi-subagents`
extension that registers `Agent`, `get_subagent_result`, or `steer_subagent`.
Unrelated extensions remain loaded. Existing child sessions remain readable.
