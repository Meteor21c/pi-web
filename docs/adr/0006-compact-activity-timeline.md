# Compact activity timeline

Introduced in MeteorAgent v0.1.19 on 2026-11-20. Updated on 2026-11-22.

## Display policy

- Live and saved conversations use the same ordered timeline. Consecutive
  thinking blocks, tool calls, and command executions form one collapsed group.
- A delivered user message replaces its own local placeholder even when Pi
  sends a system update first. Separate submissions with identical text each
  keep their own bubble.
- A localized one-line summary describes actual operations and counts, such as
  reading files or running commands. No additional model call is made to
  summarize reasoning, and raw reasoning is not copied into the summary.
- While a turn runs, progress text and activity remain visible in order
  across context compaction. On settlement, the full turn's progress and any
  open command details slide into one closed Process details disclosure.
  The final answer and delivered images stay visible. Opening the disclosure
  brings back the ordered activity with individual command details closed.
- A context compaction displays a single collapsed row. Opening it shows the
  full summary and its file details.
- A compact row above the composer shows the current phase and elapsed time
  for the active task. After 45 seconds without an activity event it reports
  that no new output has arrived. Reconnecting restores the server's last
  activity time and active tools.
- Users open activity details with a click. Search scrolls to visible stage text
  or the corresponding activity summary. Stored block indices keep deferred
  thinking linked to its original message.
- Subagent launches and completion notifications use localized task rows.
  A background notification updates an existing launch row for the same
  child when its anchor is loaded. The main model still receives the result.
  Selecting the row opens the child's transcript in the right panel.
- The disclosure counts failed tools and intermediate provider errors.
  The final provider error stays visible when the turn fails.
- Completed turns retain one aggregate usage/cost footer, image charges,
  written-file links, and copying of the final assistant message. New runs save
  their measured elapsed time once at settlement, including tool waits and
  automatic continuations. The timer excludes idle time between runs. Tool
  rows use the execution duration recorded by Pi.
- A completed turn with file outputs shows one file summary with distinct
  paths from its successful tools. Each row opens in the right panel. Edit
  and write results, local image artifacts, and observed literal shell
  redirects can contribute paths. Arbitrary command text and the repository's
  existing changes are not used as evidence.
- Messages, the composer and the welcome view share a centered reading column
  and responsive side gutters. The right panel has smaller gutters for its
  available width.

## Scope

Stage updates use text returned by the model. Run timing is stored as hidden
metadata. Shell tools still use Pi's execution and cancellation behavior. The
Bash tool description asks the model to stream progress, select a timeout
appropriate for network work, and check what finished before retrying.
