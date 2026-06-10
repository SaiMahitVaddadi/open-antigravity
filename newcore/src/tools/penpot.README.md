# Penpot tools

Seven `penpot.*` tools that let an OpenGravity agent drive a live
Penpot design and run batch / export ops against the Penpot MCP server.

## External services

| Service                     | Default URL              | Env override         | Notes |
|-----------------------------|--------------------------|----------------------|-------|
| Antigravity Bridge plugin   | `http://localhost:9010`  | `PENPOT_BRIDGE_URL`  | HTTP proxy in front of the in-browser plugin; required for live ops. |
| Penpot MCP server           | `http://localhost:4401`  | `PENPOT_MCP_URL`     | Penpot's own MCP server (`/mcp` Streamable HTTP endpoint). |

Both services must be running for the corresponding tools to succeed.
If they're not, the tools return a clean `{success:false, error: "…"}`
rather than throwing — the agent loop sees a failed step and can react.

## Tool reference

### Live ops (route via the bridge → plugin)

| Tool                  | Input                                                              | Returns                                                | When to use |
|-----------------------|--------------------------------------------------------------------|--------------------------------------------------------|-------------|
| `penpot.set_markup`   | `{ markup: string }`                                               | Whatever the plugin returns (usually `{ok:true}`)      | Full-page rewrites |
| `penpot.patch_markup` | `{ patch: string }` (unified diff)                                 | `{ok:true}` or apply errors                            | Surgical one-line edits |
| `penpot.list_shapes`  | `{ page?: string, filter?: { type?: string, name?: string } }`     | `Array<{id,name,type,x,y,w,h}>`                        | Discovery / inspection |
| `penpot.mutate_shape` | `{ shapeId: string, fields: { [dottedPath]: any } }`               | Mutated shape summary                                  | Targeted prop tweaks (e.g. `props.fill`, `x`, `y`) |

### Batch ops (route via the Penpot MCP server)

| Tool                          | Input                                                  | Returns                                  | When to use |
|-------------------------------|--------------------------------------------------------|------------------------------------------|-------------|
| `penpot.export_shape`         | `{ shapeId: string, format: "png"|"svg"|"pdf" }`       | base64 image / SVG text                  | Snapshots, asset hand-off (pdf currently surfaces an unsupported-format error — the upstream MCP supports png/svg only) |
| `penpot.search`               | `{ query: string, limit?: number }`                    | `{ matches: [...], count: number }`      | Cross-file search by name/type/text |
| `penpot.high_level_overview`  | `{}`                                                   | Textual summary of pages/libraries/components | First call when orienting in an unfamiliar file |

### Paradigm

- Prefer **markup ops** (`set_markup`, `patch_markup`) for structural changes — adding shapes, restructuring layout, multi-shape edits.
- Use **`mutate_shape`** only for targeted prop tweaks on one known shape.
- Always call **`high_level_overview`** first when entering an unfamiliar file.

## Smoke-test the tool surface

After `npm run server`, the tools appear in `/info` and `/tools`:

```bash
curl http://localhost:3777/info | jq '.tools[] | select(.name | startswith("penpot."))'
curl http://localhost:3777/tools  | jq '.[] | select(.name | startswith("penpot.")) | .name'
```

To exercise a tool through an agent (will fail unless the plugin is connected, but the
plan should choose the right tool):

```bash
curl -X POST http://localhost:3777/agents \
  -H 'Content-Type: application/json' \
  -d '{"task":"List all shapes on the current Penpot page"}'
```

There is no direct `/tools/:name` invoke endpoint on the server today —
tools are invoked by agents via the planning loop. The unit tests
(`src/tools/penpot.test.ts`) exercise each tool's `execute()` directly
against an unreachable backend.

## MCP transport notes

The MCP-routed tools (`export_shape`, `search`, `high_level_overview`)
speak the Streamable HTTP variant of the MCP wire protocol against
`/mcp`:

1. `initialize` JSON-RPC request (no `mcp-session-id` header)
2. Server returns the session id in the `mcp-session-id` response header
3. `notifications/initialized` (best-effort)
4. `tools/call` JSON-RPC request with the session header

The client tolerates responses returned either as `application/json`
or as `text/event-stream` (SSE-wrapped JSON-RPC), since the Penpot MCP
server uses the SDK's `StreamableHTTPServerTransport` which negotiates
either form.
