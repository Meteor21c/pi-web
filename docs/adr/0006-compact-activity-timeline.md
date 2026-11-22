# Compact activity timeline

Introduced in MeteorAgent v0.1.19 on 2026-11-20. Updated on 2026-11-22.

## Display policy

- Live and saved conversations use the same ordered timeline. Consecutive
  thinking blocks, tool calls, and command executions form one collapsed group.
- A localized one-line summary describes actual operations and counts, such as
  reading files or running commands. No additional model call is made to
  summarize reasoning, and raw reasoning is not copied into the summary.
- Assistant text, direct assistant images, and successful image-generation
  results remain visible in their original positions. Screenshots and images
  read by tools stay in the activity group until their tool row is opened.
- A context compaction displays a single collapsed row. Opening it shows the
  full summary and its file details.
- Active groups show the existing runtime phase. The waiting indicator is a
  quiet inline status rather than a separate card.
- Users open activity details with a click. Search scrolls to visible stage text
  or the corresponding activity summary. Stored block indices keep deferred
  thinking linked to its original message.
- Subagent launches are visible as task rows with status. Selecting a row opens
  its conversation in the right panel while the main conversation stays open.
- Failed tools are counted visibly on the summary. Provider errors remain
  outside collapsed groups.
- Completed turns retain one aggregate usage/cost footer, image charges,
  written-file links, and copying of the final assistant message.
- A completed turn with file outputs shows one file summary with distinct
  paths from its successful tools. Each row opens in the right panel. Edit
  and write results, local image artifacts, and observed literal shell
  redirects can contribute paths. Arbitrary command text and the repository's
  existing changes are not used as evidence.
- Messages, the composer and the welcome view share a centered reading column
  and responsive side gutters. The right panel has smaller gutters for its
  available width.

## Scope

This is a presentation change. It does not alter provider requests, system
prompts, agent iterations, tools, stored messages, or billing calculations.
Stage updates use the text the model returned. The old preference for always
expanding thinking is ignored.
