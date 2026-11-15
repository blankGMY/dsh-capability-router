# Acceptance — 0.1.0

Date: 2026-11-16. This report contains sanitized measurements, not private prompts, memory, account results, credentials or deployment configuration.

## Automated tests

**22 tests passed** on both:

- Windows 11, Node 24.18.1, pinned DSH core 0.2.2-rc.1.
- Raspberry Pi 4B / ARM64, Node 24.14.0, the installed DSH core 0.2.2-rc.1.

Commands: `npm test` (8 tests), `npm run test:runtime` (14 tests). Runtime tests use the real DSH tool registry, guards, scopes, native execution pipeline and V4 persistence relationship validator. MCP lifecycle tests spawn a local protocol fixture. A startup compatibility test also rejects duplicate host-core copies before they can break scope identities.

Covered: catalogs larger than 255 tools, Chinese/English retrieval, exact IDs, pagination, source filtering, schema versions, late registration, removed tools, denied and conditional tools, inherited child restrictions, media and presenter delegation, metadata/finalizers/context, cancellation, bounded concurrency, exclusive barriers, unload/reload, stateful sessions, idle reconnection and writes whose responses are lost.

## Live deployment

A single existing DSH web service was used. REA was transferred from its original disabled native-client row to the router's managed source; its capabilities were restored, not removed. The DS Bot GitHub connector was re-enabled with its existing account and native connection owner.

| Check | Observed result |
|---|---|
| Complete REA discovery | 255 tools discovered and cached |
| Cold REA discovery | 7,164 ms in the measured run; event-loop heartbeat continued |
| Codex route | Searched REA and described a decompilation tool |
| DeepSeek route | Searched, described and actually called the GitHub authenticated-user read tool |
| REA business call | `list_cutter_sessions` executed; an empty session list was a valid result |
| Native media | A temporary test tool saved a red PNG through DSH attachment storage; the model received it and identified a red square |
| Post-restart continuation | GitHub, REA session listing and native media calls succeeded again |

The media fixture and private model-selection hook are test infrastructure, not part of the public plugin or its permanent runtime tool set.

After removing that temporary infrastructure and restarting again, all three acceptance sessions could be read successfully. The existing skill directory returned 10 entries; a memory recall returned 6 hits without error; the original default model selection remained unchanged. Both LAN and Funnel entrances passed unauthenticated rejection, authenticated HTTP/session access, and authenticated WebSocket upgrade checks.

## Tool-schema measurements

Same JSON-character measurement routine, from actual persisted request headers:

| Configuration | Model-visible tools | Tool-schema JSON characters |
|---|---:|---:|
| Earlier full catalog baseline | 365 | 434,105 |
| Temporary REA/GitHub-disabled baseline | 67 | 57,888 |
| Router, REA/GitHub capabilities restored | **16** | **14,812** |

That is **74.4% less schema text than the temporary disabled baseline**, while restoring the large MCP capabilities; **96.6% less than the earlier full catalog baseline**. The real request schemas stayed at 16 entries while tools were searched, described and called.

The first Codex discovery request reported 19,490 input tokens. A corresponding initial DeepSeek request reported 13,975 uncached + 6,272 cache-read input tokens. These are examples, not guarantees for other tasks. Search/describe add model round trips; history, memory injection, media and server instructions still consume context. This report does not equate schema reduction with an identical bill reduction.

## Persistence fixes verified before release

The full-catalog deployment exposed eager SDK output-validator compilation. The implementation now defers compilation to the first actual call of each tool while retaining validation, with a regression test covering 300 unused output schemas.

A restart test also caught a distinction between model-call identities and real execution identities. Released code preserves the original model call name, arguments and ID for native batch settlement, translates only the invocation sent through the guarded pipeline, and delegates presenters through scoped bridge definitions. It does not create unknown mandatory session events. The native V4 validator regression test accepts the routed history and rejects the original mismatched-name failure mode.

Development-only test logs affected by the earlier implementation were backed up and repaired; production acceptance includes reading them after restart and executing new calls. No private log is included here.

## Limits of this acceptance

- It does not execute all 255 REA tools or run a binary decompilation workload.
- PTC/custom executor modes remain available unchanged but are not optimized by this release.
- No independent management web UI, generic OAuth implementation, MCP sampling/elicitation or full MCP resource/prompt bridge is claimed.
- Stateful REA is intentionally not idled. Stateless idle recovery is covered by the fixture tests.
- Automatic semantic matching is not guaranteed perfect. Only the listed lexical/alias behaviors are tested.
- No claim is made that all DSH versions or model providers are supported.

See the repository's Test workflow for reproducible CI results. Private operational rollback instructions are retained with the deployment, not published.
