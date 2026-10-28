# Pi upstream review for MeteorAgent v0.1.16

Reviewed on 2026-10-28. Latest upstream Pi release: 1.4.0 (2026-10-21).

## Included

- Pi 0.86.1 and 0.87.1, with all four directly consumed SDK packages pinned to
  0.87.1. This includes recovery/context fixes in 0.87.0, image-only user message
  compatibility with OpenAI-compatible gateways, split-turn compaction fixes,
  and updated model metadata. Magent still uses its account/key-specific relay
  model catalog and pricing.
- pi-web commit `e533d9b3975f8a74b378d5007c92fdf4d15d3fba`: adapt new-conversation
  shortcut matching for macOS dead keys without swallowing Windows AltGr text.
- pi-web commit `f7f8f45085a16e606bf96d84170dcd31df978739`: save through a
  symbolic models.json link instead of replacing it. Adapted to retain Magent's
  existing relay authorization filtering; dangling links fail before writing.

Pi 0.87.0 makes SessionManager canonical for context and adds context-edit entries
and extension boundaries. Verify the wrapper's system projection, tool gating,
resume/fork/compaction and SDK type boundary against this version during release.

## Deferred

Pi 0.99–1.4 adds codemode, built-in MCP and image generation APIs, changes tool
and extension behavior, and includes additional fixes. A full migration needs a
separate compatibility pass against Magent's plugins, image billing, session
activation controls and relay adapters. These features are not advertised as
part of v0.1.16. No blanket upstream branch merge is performed.

The SDK's published shrinkwrap pins its own undici and brace-expansion releases.
The root customer lock pins undici 8.12.3 and brace-expansion 5.0.12. Because
npm ci can still install the SDK shrinkwrap versions despite the override and
root lock, the package postinstall prepares those two nested dependencies from
the exact audited root copies. Replaced directories are moved to a local backup,
not deleted. Preparation is idempotent and rejects unexpected root versions.
Fresh npm ci and actual SDK module resolution must confirm these versions.

The brand build copies only Git-tracked files from the verified clean checkout,
keeping ignored browser logs, caches and developer files out of the release
source snapshot. A local independent clone may be supplied with
METEOR_SOURCE_DIR when the main checkout has cloud-offloaded Git metadata.

## Sources

- https://github.com/earendil-works/pi/releases/tag/v0.86.1
- https://github.com/earendil-works/pi/releases/tag/v0.87.0
- https://github.com/earendil-works/pi/releases/tag/v0.87.1
- https://github.com/earendil-works/pi/releases/tag/v1.4.0
- https://github.com/agegr/pi-web/commit/e533d9b3975f8a74b378d5007c92fdf4d15d3fba
- https://github.com/agegr/pi-web/commit/f7f8f45085a16e606bf96d84170dcd31df978739
