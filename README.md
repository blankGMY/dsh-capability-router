# DSH Capability Router

Keep installed capabilities available without sending every tool schema to the model on every request.

**Compatibility:** DeepSeek Harness **0.2.2-rc.1**, Node **24+**. This project uses pre-stable DSH executor APIs and intentionally pins its peer versions. It is not an access-control bypass.

## How it works

The model sees your pinned tools and three stable discovery tools:

| Tool | Purpose |
|---|---|
| `capability_search` | Search the complete scope-admitted catalog using keywords, Chinese aliases, exact IDs, source filters, or pagination. |
| `capability_describe` | Fetch complete schemas for selected IDs, with version tokens. |
| `capability_call` | Dispatch a precise ID and arguments through DSH's real native pipeline. |

Definitions are never removed from the registry just to save tokens. The router changes their **presentation**, not their **authorization**. Calls retain native guards, admission, cancellation, concurrency classification, media, finalizers, metadata and tool-call IDs. Used tools are not permanently promoted into the model's schema array.

The scope-aware catalog includes MCP tools, memory, schedules, remote workspaces and other registered plugin tools. Skill bodies are still loaded by DSH's existing `skill` tool.

## Install

```sh
dsh plugin --profile web add github:blankGMY/dsh-capability-router
```

Restart DSH after installation. The package includes its own bundle patch. No npm publication is required for GitHub installation.

Optional profile overrides in `cordis.patch.yml`:

```yaml
- id: capability-router
  config:
    pinnedTools: [read, write, edit, glob, grep, bash, read_image, skill, memory_recall, memory_note]
    maxResults: 5
    maxParallel: 4
    aliases:
      mcp__example__inspect_binary: [二进制体检]
```

There is no forced maximum pinned-tool count. An explicit `pinnedTools` list replaces the default. Unknown configuration keys fail visibly.

## Optional managed MCP lifecycle

Existing MCP clients remain owned by their original plugins and are simply routed. To also start a particular MCP server on demand, transfer **only that server** to the router:

```yaml
- id: capability-router
  config:
    servers:
      - serverName: example
        transport: stdio
        command: /absolute/path/to/server
        args: [--mcp]
        stateless: false
```

Disable the duplicate native client for that server when transferring ownership. This does not disable its capabilities: the router becomes their owner. Do not leave both owners enabled. A duplicate is an explicit error.

Supported transports: `stdio` and `streamable-http` (`url`, optional `headers`). Credentials may be provided in deployment configuration but are never included in catalog results. Prefer the host's credential/environment facilities over literals in files. OAuth remains the responsibility of the original connector; do not migrate an OAuth-managed connector just to use this router.

On a cold cache, use `capability_search({query:"...",source:"example"})` to discover metadata, then repeat in the next model step. Cached definitions register without spawning the source; the first call connects once. Sources are shared between callers, never between unauthorized scopes.

Only a source explicitly marked `stateless: true` can be idled; its default timeout is 10 minutes (`idleTimeoutMs` overrides it). Stateful debugging/GUI services stay connected. A disconnected source restarts on a later call, **never by replaying a failed business operation**. A lost write response is reported as an unknown outcome.

The metadata cache lives at `$DSH_HOME/storages/capability-router` (or an explicit `cacheDir`), with private file permissions. It stores tool metadata and a configuration fingerprint, not credential values. Server instructions are returned on demand with descriptions.

## Diagnostics and boundaries

- `capability_search` with an empty query browses all admitted tools and reports source state; it does not return all schemas.
- The package logs readiness or explicit fallback without printing credential values or MCP stderr.
- **PTC and custom executors are preserved unchanged and currently unoptimized.** The router never silently removes code execution by replacing another executor.
- Normal native-mode agents, including scope restrictions and conditional registrations, are supported. The plugin restores the previous executor on unload and supports reload.
- Rendering uses DSH's existing native presenters and durable IDs; no separate unguarded HTTP endpoint is added.
- Stable tool schemas improve prefix stability, not a guarantee of whole-prompt cache hits. Descriptions, history and results still consume tokens.
- Search is lexical plus configured/default Chinese aliases, not a claim of perfect semantic recall. Names not yet advertised by a source cannot be inferred.
- MCP images use DSH's native image admission and attachment storage. The router does not turn images into plain text. Text-only models and other existing host restrictions still apply.
- A managed source's catalog refreshes when it reconnects. Reconnect after changing a server's catalog before using new definitions. MCP resources, prompts, sampling and elicitation are not independently implemented by the managed-client option; keep original clients when those are required.
- Configuration is file-based in this release; there is no separate administrative web panel. Original DS Bot/DSH settings remain available.
- Unloading restores the native executor. If you transferred ownership of a managed server, also restore its original client configuration when removing the router.
- Output validation is preserved, but validators compile only when the corresponding tool is actually called. Large catalogs do not eagerly compile every unused output schema.

## Tests

```sh
npm ci --ignore-scripts
npm test
npm run test:runtime
```

Runtime tests use real pinned DSH core packages, not a fake registry/pipeline. MCP lifecycle tests spawn a local protocol fixture. They cover large catalogs, permissions, schema drift, late registration, media, cancellation, unload/reload, stateful sessions, idle recovery and non-replayed writes.

See [acceptance evidence](docs/ACCEPTANCE.md) for the tested deployment and measured results. Private configurations and runtime data are intentionally excluded.

## Acknowledgements

The discovery/describe/call pattern is informed by [Hermes Tool Search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search) and the fixed gateway approach in [wings1848/dsh-mcp-lazy](https://github.com/wings1848/dsh-mcp-lazy). This implementation uses DSH's exported executor and MCP result-projection APIs rather than copying another plugin's implementation.

MIT licensed. Dependencies retain their own licenses.

[中文说明](README.zh-CN.md)
