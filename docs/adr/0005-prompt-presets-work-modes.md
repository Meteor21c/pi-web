# Prompt presets and work modes

Date: 2026-10-28. Status: shipped in v0.1.18. The additive preset implementation shipped in v0.1.17 and was superseded by the full-prompt design.

## User experience

Settings → Prompt presets manages multiple named complete system prompts. The
top Assistant rules panel selects a full prompt for new conversations and edits
the MeteorAgent default prompt. Selecting a preset replaces the default prompt
instead of appending to it. Auto /
Plan / Goal lives below the chat input, beside the model selector. Prompt preset
settings do not include a mode control. The complete generated prompt is folded
by default. A started conversation displays its persisted mode in the composer
and its own applied preset in Assistant rules. Mode changes are available before
the first message in a new conversation.

Modes are independent of presets:

- Auto keeps the normal tool policy and task behavior.
- Plan analyzes and produces a plan with available built-in read-only tools.
- Goal asks the assistant to continue within one task, verify the outcome, and
  explain results or a genuine blocker. It does not create a scheduler, durable
  goal service, unlimited retry loop, or automatic future user messages.

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

## Actual provider prompt

Pi 0.87.1 represents prompts as structured system messages, with tools declared in
`toolsAdded`. `agent.state.systemPrompt` is a read-only replayed getter. A v2
selection projects the complete chosen prompt into the provider request while
preserving active tool declarations. It does not mutate the source transcript and
applies to the first request, tool-loop continuations, context compaction, and
later turns. Plan/Goal instructions are applied separately. Existing v1
conversation snapshots keep their original additive behavior.

Plan mode filters active tools and provider tool definitions to read/grep/find/ls.
A chained `beforeToolCall` blocks other model-requested tools even if a plugin
changes the live tool loadout. Web shell commands and slash commands are blocked.
The restriction does not sandbox installed extensions or revoke their OS user
permissions; their lifecycle code still runs under the existing plugin policy.

## Verification

An isolated dependency installation passed TypeScript and ESLint. A local SDK
simulation exercised first and subsequent requests, a context reset, snapshot
stability after editing/deletion, corruption preservation, and actual prevention
of a write tool execution in Plan mode. Goal mode retained the same simulated
tool execution. No paid model requests were made. Browser checks cover preset
creation, saving, default selection, mode switching, and responsive layout.
