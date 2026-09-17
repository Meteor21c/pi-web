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
