# Prompt presets and work modes

Date: 2026-10-28. Status: included in MeteorAgent v0.1.16.

## User experience

Settings → Prompt presets manages multiple named instruction presets. The top
Assistant rules panel selects an optional preset for new conversations. Auto /
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

`getAgentDir()/meteoragent-prompt-presets.json` contains version 1, a preset list,
`selectedPresetId`, and `mode`. Presets are global to the local Magent instance.
The API applies individual operations against the latest file and writes it
atomically with mode 0600. It checks trusted request origins, JSON content,
preset shape, unique identifiers, maximum 100 presets, names up to 80 characters,
and content up to 32,000 characters. Malformed files are not silently reset.

New main conversations save a `meteoragent:prompt-selection` custom entry with
the selected preset's id, name, and **content copy**, plus mode. Auto/no preset is
also explicit. Runtime creation for command discovery may precede the first user
message; an empty runtime refreshes the selection before its first prompt.
Once a user or assistant message exists anywhere in the session, global changes
cannot replace the snapshot. Resuming, reloading, and branching retain stored
metadata; a fork before all messages explicitly copies the snapshot. Legacy
conversations without metadata do not adopt the current default. Subagents keep
their existing profile prompt behavior.

Deleting a preset clears it as a new-conversation default but does not remove
snapshots in existing conversations. This operation edits a single JSON file;
it never deletes directories or session files.

## Actual provider injection

Pi 0.86 represents prompts as structured system messages, with tools declared in
`toolsAdded`. `agent.state.systemPrompt` is a read-only replayed getter.
The wrapper chains `agent.transformContext` after the SDK's existing projection
and adds the instructions as a named section of the leading system message.
The source transcript is not mutated. This covers the first request, tool-loop
continuations, context compaction, and later user turns without accumulating
duplicate text. Tool/project instructions and custom preset text are preserved.

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
