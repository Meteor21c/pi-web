# ADR 0004: Session-scoped image generation

## Status

Accepted, 2026-09-17.

## Decision

Magent keeps the conversational model and the image-generation model as two
separate session controls. The conversation model remains the agent controller;
the selected image model is consumed by `@amaster.ai/pi-image-gen` through its
`image_generate` tool.

Relay synchronization partitions dedicated image endpoints out of
`models.json`, stores them in relay group metadata, and writes Magent-managed
custom providers under the package's `pi-image-gen` settings. Managed providers
use the relay's OpenAI Images-compatible base URL and retain each upstream model
ID. API keys remain in `auth.json`; settings contain only environment-variable
placeholders hydrated immediately before extensions load.

The global image model is the default for new sessions. A session override is
stored as a versioned `magent:image-model-selection` custom JSONL entry. The
community package bypasses Pi's SettingsManager and reads `settings.json`
directly, so the managed `defaultModel` is an environment placeholder. Magent
serializes extension-load windows and resolves that placeholder to the session
selection only while each extension instance loads; it then restores the
global default. Because the package registers a model-aware tool schema,
changing the selection reloads the idle session before the new model can be
used.

## Consequences

- Image generation stays in the same conversation and its output is rendered
  in the normal assistant transcript.
- Selecting an image endpoint cannot accidentally replace the model that plans
  and executes the conversation.
- New image families can be synchronized without an OpenAI-specific UI, as long
  as the relay exposes them through the compatible Images endpoint.
- The community package is one of Magent's optional starter capabilities: first
  launch prepares it in the background from its official npm source, while the
  existing source warning, progress UI, and local-permission disclaimer remain.
  Users can update, disable, or remove it from Settings; removal is respected on
  later launches until the user explicitly retries preparation.
- A real paid relay request is still required as a release acceptance test.

## Result and file links

Assistant images, image-tool results, and Markdown images use a compact
thumbnail in the transcript (420 × 320 CSS pixels at most). Clicking a
thumbnail opens the original in the accessible modal preview, so high-
served through the existing file allow-list and can be opened in Magent's file
panel; Markdown `file:///...` images are converted to the same scoped API
before loading. Remote HTTP(S) images stay in the modal preview, while normal
external links—and URL-looking inline code such as `https://...` or
`www....`—open in a new browser tab.

Inline paths such as `/Users/me/output.png`, `C:\\Users\\me\\output.pdf`,
`file:///...`, and source-location suffixes such as `report.pdf:12` are
recognized when they are presented as inline code. They become safe file
actions and are resolved against the active project for relative names. Shell
commands and external URL schemes are deliberately left as code. The file
panel dispatches recognized image, audio, video, PDF, DOCX, Markdown, HTML, and
text formats to their corresponding preview; unsupported or binary formats
remain downloadable rather than being sent to an arbitrary external program.

## Billing display

Successful `image_generate` results are recorded in a private
`magent:image-billing` session entry. The normal text usage ledger remains
independent; the web client reconciles image rows by normalized model and a
five-minute completion window, with one upstream row used at most once. Older
sessions are discovered from their tool results, so they do not need to be
regenerated after upgrading.

The final answer for a user turn shows the summed text input/output/cache and
text charge. A separate image-charge chip appears only when an image was
actually returned. It is muted while the relay ledger is still pending and
switches to the theme color once the authoritative image charge is matched.
