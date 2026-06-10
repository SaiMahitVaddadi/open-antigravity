// ═══════════════════════════════════════════════════════════════
// OpenGravity — Penpot Tools
// Drives Penpot via two backends:
//   1. Antigravity Bridge plugin tool proxy (http://localhost:9010/tool)
//      — live-canvas ops while a human has Penpot open with the plugin
//   2. Penpot MCP server (http://localhost:4401/mcp, Streamable HTTP)
//      — batch/export/overview ops
// All tools return ToolResult; HTTP failures are mapped to {success:false}
// rather than thrown, because the agent loop relies on success/failure
// being a return value.
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';
import type { Tool, ToolInput, ToolResult, ToolContext } from '../types/index.js';
import { getConfig } from '../config/index.js';

// ── Defaults ──

const DEFAULT_LIVE_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_TIMEOUT_MS = 30_000;

// ── Internal: bridge plugin proxy client ──

interface BridgeRequest {
  name: string;
  input: unknown;
  timeoutMs?: number;
}

interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * POST to the Antigravity Bridge plugin tool proxy at /tool.
 * Returns a ToolResult — never throws.
 */
async function callBridge(req: BridgeRequest, timeoutMs: number): Promise<ToolResult> {
  const cfg = getConfig();
  const url = `${cfg.penpotBridgeUrl.replace(/\/$/, '')}/tool`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...req, timeoutMs: req.timeoutMs ?? timeoutMs }),
      signal: controller.signal,
    });

    const text = await res.text();
    let body: BridgeResponse | undefined;
    try { body = text ? JSON.parse(text) as BridgeResponse : undefined; } catch { /* ignore */ }

    if (res.status === 503) {
      return {
        success: false,
        output: '',
        error: body?.error ?? 'no_plugin_connected — open Penpot with the Antigravity Bridge plugin loaded',
      };
    }
    if (res.status === 504) {
      return { success: false, output: '', error: body?.error ?? 'timeout — plugin did not respond in time' };
    }
    if (!res.ok) {
      return { success: false, output: '', error: body?.error ?? `bridge HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    if (!body || body.ok === false) {
      return { success: false, output: '', error: body?.error ?? 'bridge returned ok=false' };
    }

    const out = typeof body.result === 'string' ? body.result : JSON.stringify(body.result, null, 2);
    return { success: true, output: out, metadata: { backend: 'bridge', tool: req.name } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      return { success: false, output: '', error: `timeout after ${timeoutMs}ms calling bridge tool ${req.name}` };
    }
    return { success: false, output: '', error: `bridge unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── Internal: MCP Streamable-HTTP client (minimal) ──

/**
 * One-shot MCP tools/call against the Penpot MCP server.
 *
 * Performs initialize → tools/call as two JSON-RPC messages on /mcp,
 * tracking the mcp-session-id header issued during initialize.
 *
 * Streamable HTTP can return either JSON or SSE (text/event-stream);
 * we parse both. If the protocol negotiation fails, we map the error
 * to {success:false} rather than throwing.
 */
async function callMcpTool(
  toolName: string,
  args: unknown,
  timeoutMs: number,
): Promise<ToolResult> {
  const cfg = getConfig();
  const url = `${cfg.penpotMcpUrl.replace(/\/$/, '')}/mcp`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const post = async (body: unknown, sessionId?: string) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  };

  // Parse a response that may be JSON or SSE-formatted.
  const readJsonRpc = async (res: Response): Promise<any> => {
    const ct = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (ct.includes('text/event-stream')) {
      // Find the last "data:" line containing valid JSON.
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (!data) continue;
          try { return JSON.parse(data); } catch { /* keep scanning */ }
        }
      }
      throw new Error(`unparseable SSE body: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  };

  try {
    // 1. initialize
    const initRes = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'opengravity-engine', version: '0.1.0' },
      },
    });

    if (!initRes.ok) {
      const t = await initRes.text();
      return { success: false, output: '', error: `MCP initialize failed (${initRes.status}): ${t.slice(0, 200)}` };
    }
    const sessionId = initRes.headers.get('mcp-session-id') ?? undefined;
    const initBody = await readJsonRpc(initRes);
    if (initBody?.error) {
      return { success: false, output: '', error: `MCP initialize error: ${initBody.error.message ?? JSON.stringify(initBody.error)}` };
    }

    // 1b. notifications/initialized (best-effort; some servers require it)
    try {
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    } catch { /* ignore */ }

    // 2. tools/call
    const callRes = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args ?? {} },
    }, sessionId);

    if (!callRes.ok) {
      const t = await callRes.text();
      return { success: false, output: '', error: `MCP tools/call failed (${callRes.status}): ${t.slice(0, 200)}` };
    }

    const callBody = await readJsonRpc(callRes);
    if (callBody?.error) {
      return { success: false, output: '', error: `MCP tool ${toolName} error: ${callBody.error.message ?? JSON.stringify(callBody.error)}` };
    }

    // The result follows the MCP tool result shape: { content: [{type, text|data, ...}], isError? }
    const result = callBody?.result;
    if (result?.isError) {
      const errText = (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
      return { success: false, output: '', error: `MCP tool ${toolName} returned isError: ${errText.slice(0, 500)}` };
    }

    const parts = (result?.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    const textOut = parts.map(p => {
      if (p.type === 'text') return p.text ?? '';
      if (p.type === 'image') return `[image:${p.mimeType ?? 'binary'};base64,${(p.data ?? '').slice(0, 64)}…]`;
      return JSON.stringify(p);
    }).join('\n');

    return {
      success: true,
      output: textOut || JSON.stringify(result, null, 2),
      metadata: { backend: 'mcp', tool: toolName, raw: result },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      return { success: false, output: '', error: `timeout after ${timeoutMs}ms calling MCP tool ${toolName}` };
    }
    // ECONNREFUSED & friends bubble up here.
    return { success: false, output: '', error: `MCP unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ──

/**
 * Validate input with a zod schema. Returns either parsed data or a
 * pre-built failure ToolResult — never throws.
 */
function validate<T>(schema: z.ZodType<T>, input: ToolInput): { ok: true; data: T } | { ok: false; result: ToolResult } {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return {
    ok: false,
    result: { success: false, output: '', error: `invalid input — ${issues}` },
  };
}

// ── Tool 1: penpot.set_markup (live, bridge) ──

const SetMarkupSchema = z.object({
  markup: z.string().min(1, 'markup cannot be empty'),
});

export class PenpotSetMarkupTool implements Tool {
  name = 'penpot.set_markup';
  description = 'Replace the entire design markup in Penpot\'s Antigravity Bridge plugin. Triggers a live re-render of the Penpot canvas. Use for full-page rewrites; for surgical edits prefer penpot.patch_markup.';
  parameters = {
    type: 'object',
    properties: {
      markup: { type: 'string', description: 'Full DSL markup text that will replace the current markup pane contents.' },
    },
    required: ['markup'],
  };

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const v = validate(SetMarkupSchema, input);
    if (!v.ok) return v.result;
    return callBridge({ name: 'set_markup', input: v.data }, DEFAULT_LIVE_TIMEOUT_MS);
  }
}

// ── Tool 2: penpot.patch_markup (live, bridge) ──

const PatchMarkupSchema = z.object({
  patch: z.string().min(1, 'patch cannot be empty'),
});

export class PenpotPatchMarkupTool implements Tool {
  name = 'penpot.patch_markup';
  description = 'Apply a unified-diff patch to the current Penpot markup. Use for surgical one-line tweaks; for structural rewrites prefer penpot.set_markup.';
  parameters = {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'A unified-diff patch (e.g. starts with "@@") to apply against the current markup.' },
    },
    required: ['patch'],
  };

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const v = validate(PatchMarkupSchema, input);
    if (!v.ok) return v.result;
    return callBridge({ name: 'patch_markup', input: v.data }, DEFAULT_LIVE_TIMEOUT_MS);
  }
}

// ── Tool 3: penpot.list_shapes (live, bridge) ──

const ListShapesSchema = z.object({
  page: z.string().optional(),
  filter: z
    .object({
      type: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
});

export class PenpotListShapesTool implements Tool {
  name = 'penpot.list_shapes';
  description = 'List shapes on the current (or named) Penpot page, optionally filtered by type or name. Returns an array of {id,name,type,x,y,w,h}.';
  parameters = {
    type: 'object',
    properties: {
      page: { type: 'string', description: 'Optional page name; defaults to current page.' },
      filter: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Filter by shape type (e.g. "rect", "text").' },
          name: { type: 'string', description: 'Filter by shape name substring.' },
        },
      },
    },
  };

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const v = validate(ListShapesSchema, input);
    if (!v.ok) return v.result;
    return callBridge({ name: 'list_shapes', input: v.data }, DEFAULT_LIVE_TIMEOUT_MS);
  }
}

// ── Tool 4: penpot.mutate_shape (live, bridge) ──

const MutateShapeSchema = z.object({
  shapeId: z.string().min(1, 'shapeId cannot be empty'),
  fields: z.record(z.unknown()).refine(o => Object.keys(o).length > 0, {
    message: 'fields must contain at least one key',
  }),
});

export class PenpotMutateShapeTool implements Tool {
  name = 'penpot.mutate_shape';
  description = 'Directly mutate one Penpot shape without rewriting markup. Field keys use dotted props per the compiler convention: x, y, w, h, props.fill, props.text, etc. Prefer markup ops for structural changes.';
  parameters = {
    type: 'object',
    properties: {
      shapeId: { type: 'string', description: 'The shape id to mutate.' },
      fields: {
        type: 'object',
        description: 'Map of field paths (dotted, e.g. "props.fill") to new values.',
        additionalProperties: true,
      },
    },
    required: ['shapeId', 'fields'],
  };

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const v = validate(MutateShapeSchema, input);
    if (!v.ok) return v.result;
    return callBridge({ name: 'mutate_shape', input: v.data }, DEFAULT_LIVE_TIMEOUT_MS);
  }
}

// ── Tool 5: penpot.export_shape (batch, MCP) ──

const ExportShapeSchema = z.object({
  shapeId: z.string().min(1, 'shapeId cannot be empty'),
  format: z.enum(['png', 'svg', 'pdf']),
});

export class PenpotExportShapeTool implements Tool {
  name = 'penpot.export_shape';
  description = 'Export a Penpot shape as png/svg/pdf via the Penpot MCP server. Returns base64-encoded image data or a textual SVG; use shapeId "selection" for the current selection or "page" for the whole page.';
  parameters = {
    type: 'object',
    properties: {
      shapeId: { type: 'string', description: 'Shape id; also accepts "selection" or "page".' },
      format: { type: 'string', enum: ['png', 'svg', 'pdf'], description: 'Output format.' },
    },
    required: ['shapeId', 'format'],
  };

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const v = validate(ExportShapeSchema, input);
    if (!v.ok) return v.result;
    // Penpot's MCP export_shape supports png|svg; pdf is requested upstream
    // but not yet wired — surface a clear error instead of silently falling back.
    if (v.data.format === 'pdf') {
      return {
        success: false,
        output: '',
        error: 'pdf export not supported by Penpot MCP server (supports png|svg). Export as svg and convert client-side.',
      };
    }
    return callMcpTool('export_shape', { shapeId: v.data.shapeId, format: v.data.format }, DEFAULT_BATCH_TIMEOUT_MS);
  }
}

// ── Tool 6: penpot.search (batch, MCP via execute_code) ──

const SearchSchema = z.object({
  query: z.string().min(1, 'query cannot be empty'),
  limit: z.number().int().positive().max(500).optional(),
});

export class PenpotSearchTool implements Tool {
  name = 'penpot.search';
  description = 'Search shapes across the current Penpot file by name, type, or text content. Returns matching shape summaries.';
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Substring to match against shape name, type, or text content.' },
      limit: { type: 'number', description: 'Max number of matches to return (default 50).' },
    },
    required: ['query'],
  };

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const v = validate(SearchSchema, input);
    if (!v.ok) return v.result;
    const limit = v.data.limit ?? 50;
    // Implemented via MCP execute_code — there is no first-class MCP search tool.
    // The plugin exposes `penpot` and `penpotUtils`; we walk pages looking for matches.
    const q = JSON.stringify(v.data.query.toLowerCase());
    const code = `
      const q = ${q};
      const out = [];
      try {
        const pages = (penpot.currentFile?.pages ?? penpot.root?.pages ?? []);
        const visit = (s) => {
          if (out.length >= ${limit}) return;
          const name = (s.name ?? '').toLowerCase();
          const type = (s.type ?? '').toLowerCase();
          const text = (s.text ?? s.characters ?? '').toString().toLowerCase();
          if (name.includes(q) || type.includes(q) || text.includes(q)) {
            out.push({ id: s.id, name: s.name, type: s.type, x: s.x, y: s.y, w: s.width, h: s.height });
          }
          (s.children ?? []).forEach(visit);
        };
        for (const p of pages) (p.children ?? []).forEach(visit);
      } catch (e) {
        return { error: e.message, matches: out };
      }
      return { matches: out, count: out.length };
    `;
    return callMcpTool('execute_code', { code }, DEFAULT_BATCH_TIMEOUT_MS);
  }
}

// ── Tool 7: penpot.high_level_overview (batch, MCP) ──

const HighLevelOverviewSchema = z.object({}).strict();

export class PenpotHighLevelOverviewTool implements Tool {
  name = 'penpot.high_level_overview';
  description = 'Get a textual summary of the current Penpot file: pages, libraries, components, and overall structure. Useful as a first call when orienting in an unfamiliar file.';
  parameters = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const v = validate(HighLevelOverviewSchema, input);
    if (!v.ok) return v.result;
    return callMcpTool('high_level_overview', {}, DEFAULT_BATCH_TIMEOUT_MS);
  }
}

// ── Exported group ──

export const ALL: Tool[] = [
  new PenpotSetMarkupTool(),
  new PenpotPatchMarkupTool(),
  new PenpotListShapesTool(),
  new PenpotMutateShapeTool(),
  new PenpotExportShapeTool(),
  new PenpotSearchTool(),
  new PenpotHighLevelOverviewTool(),
];
