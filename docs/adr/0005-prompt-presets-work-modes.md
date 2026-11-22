# Prompt presets and work modes

Date: 2026-10-28. Full-prompt presets shipped in v0.1.18, superseding the additive presets in v0.1.17. Same-conversation work-mode switching is included in v0.1.21.

## User experience

Settings → Prompt presets manages multiple named complete system prompts. The
top Assistant rules panel selects a full prompt for new conversations and edits
the MeteorAgent default prompt. Selecting a preset replaces the default prompt
instead of appending to it. Auto /
Plan / Goal lives below the chat input, beside the model selector. Prompt preset
settings do not include a mode control. The complete generated prompt is folded
by default. The composer lets users switch work modes in the same conversation;
the Assistant rules panel still displays the conversation's original prompt.
An idle switch applies immediately. A switch requested while a task is running
is shown as pending and applies to the next standalone user prompt. Steering,
queued follow-ups and tool continuations keep the running task's mode.

Modes are independent of presets:

- Auto keeps the normal tool policy and task behavior.
- Plan analyzes and produces a plan with available built-in read-only tools.
- Goal tracks one objective above the composer. The user can start, pause, resume,
  edit, complete, or cancel it. A completed or cancelled objective can be replaced.

Plan and Goal turns show their actual mode beside the answer. Earlier turns
keep their own labels when the conversation changes modes. The goal stays
visible across mode changes, and the assistant uses it while running in Goal
mode. If a goal changes while a run is active, the old run cannot change its
status or launch an automatic continuation. Reopening a session restores its
goal and report. Selecting Continue starts a new run in that session.

## Persistence and compatibility

`getAgentDir()/meteoragent-prompt-presets.json` contains version 2, a preset list,
`selectedPresetId`, `mode`, and an optional `defaultSystemPrompt`. Version 1
settings are read and upgraded on the next write. Presets are global to the
local Magent instance.
The API applies individual operations against the latest file and writes it
atomically with mode 0600. It checks trusted request origins, JSON content,
preset shape, unique identifiers, maximum 100 presets, names up to 80 characters,
and prompt content up to 120,000 characters. Malformed files are not silently reset.

New main conversations save a v2 `meteoragent:prompt-selection` custom entry with
the selected preset's id, name, and **full prompt copy**, plus mode. A customized
default prompt is snapshotted the same way. Auto/default is also explicit. Runtime
creation for command discovery may precede the first user
message; an empty runtime refreshes the selection before its first prompt.
Once a user or assistant message exists anywhere in the session, global changes
cannot replace the snapshot. Resuming, reloading, and branching retain stored
metadata; a fork before all messages explicitly copies the snapshot. Legacy
conversations without metadata do not adopt the current default. Subagents keep
their existing profile prompt behavior.

Deleting a preset clears it as a new-conversation default but does not remove
snapshots in existing conversations. This operation edits a single JSON file;
it never deletes directories or session files.

Later work-mode changes are stored separately from the prompt snapshot. Pending
changes can be replaced or cancelled. Switching mode never rewrites the
conversation's saved prompt or its underlying tool selection. A new conversation
copied from an existing one inherits its effective mode, not a pending choice.

Each delivered turn records its effective mode in session metadata. Older
conversations derive a turn's mode from the mode and prompt entries available
at that point in history. Goal state is saved in a private file beside the
session. Mutations check the revision to prevent overwriting changes from
another tab. Forks have independent goals. The first goal save can persist a
new conversation before its first message.

## Actual provider prompt

Pi represents prompts as structured system messages, with tools declared in
`toolsAdded`. `agent.state.systemPrompt` is a read-only replayed getter. A v2
selection projects the complete chosen prompt into the provider request while
preserving active tool declarations. It does not mutate the source transcript and
applies to the first request, tool-loop continuations, context compaction, and
later turns. Plan/Goal instructions are applied separately. Existing v1
conversation snapshots keep their original additive behavior.

The default main-session prompt asks the model to use the user's requested
language in visible progress and the final answer, or to match the latest
substantive request. Goal continuations keep the established reply language.
The runtime projects this guidance on each ordinary provider request and skips
it when a v2 full prompt is selected. The check is part of generation and uses
the same model call.

In Goal mode, the runtime reads the active objective at the start of a run and
adds it and any previous evidence to the latest user message for the provider.
Tool continuations and queued messages keep the same goal snapshot for that run.
The system section contains the runtime's instructions for using that context.
Pi uses a separate prompt for compaction.

For a saved active goal in a tool-enabled conversation, the internal goal tool
records progress, evidence of completion, or a blocker. A normal stop with an
empty final response or a progress report can trigger one additional provider
request through Pi's pre-settlement hook. Queued user input, an edited goal, a mode
switch, or a user stop takes priority. The extra request counts toward usage.
When the run settles, a paused, blocked, or completed status and its available
evidence are saved under the starting goal revision. Completion requires a
model report with evidence or explicit user confirmation.

With Pi 1.6.0, the runtime acknowledges the SDK's started, handled, and queued
prompt dispositions. Only a started run receives the requested approval policy.
Tool restrictions also apply to nested calls made through an extension.

Pi now saves a session when the first user message arrives. MeteorAgent can still
save a goal or a prepared branch before that message. Relay compaction and
branch summaries use Pi's native output calculation unless the user configured
an explicit output limit. Ordinary relay prompts retain their configured output
policy.

Plan mode filters active tools and provider tool definitions to Pi's built-in
read/grep/find/ls. The tool guards check both the name and its SDK provenance,
including in nested calls. Web shell commands and slash commands are blocked.
The restriction does not sandbox installed extensions or revoke their OS user
permissions; their lifecycle code still runs under the existing plugin policy.

## Verification

An isolated dependency installation passed TypeScript and ESLint. A local SDK
simulation exercised first and subsequent requests, a context reset, snapshot
stability after editing/deletion, corruption preservation, and actual prevention
of a write tool execution in Plan mode. Goal mode retained the same simulated
tool execution. Same-conversation regression tests cover idle switching, queue
isolation, rejected submissions, reopening, and branch inheritance. A browser
check against a loopback relay verified that a queued follow-up stays read-only
and a subsequent standalone prompt restores the configured tools. No paid model
requests were made.
