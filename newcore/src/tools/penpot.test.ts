// ═══════════════════════════════════════════════════════════════
// OpenGravity — Penpot tool tests
// Run with: tsx --test src/tools/penpot.test.ts
//
// These tests do NOT hit the real bridge or MCP — instead they point
// the URLs at an unreachable port so we can assert clean error mapping.
// ═══════════════════════════════════════════════════════════════

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Force unreachable endpoints BEFORE importing anything that loads config.
process.env.PENPOT_BRIDGE_URL = 'http://127.0.0.1:1';
process.env.PENPOT_MCP_URL = 'http://127.0.0.1:1';

const { loadConfig } = await import('../config/index.js');
loadConfig(); // ensure config sees our env overrides

const {
  ALL,
  PenpotSetMarkupTool,
  PenpotPatchMarkupTool,
  PenpotListShapesTool,
  PenpotMutateShapeTool,
  PenpotExportShapeTool,
  PenpotSearchTool,
  PenpotHighLevelOverviewTool,
} = await import('./penpot.js');
const { ToolRegistry } = await import('./index.js');

import type { ToolContext, ToolResult } from '../types/index.js';

const stubCtx: ToolContext = {
  workspaceDir: '/tmp',
  agentId: 'test-agent',
  policyEngine: { check: () => ({ allowed: true, reason: 'test' }) },
  auditLog: { log: () => {} },
};

// ── 1. Group registers ──

describe('penpot tools — registration', () => {
  test('ALL exports exactly 7 tools with penpot.* names', () => {
    assert.equal(ALL.length, 7);
    const names = ALL.map(t => t.name).sort();
    assert.deepEqual(names, [
      'penpot.export_shape',
      'penpot.high_level_overview',
      'penpot.list_shapes',
      'penpot.mutate_shape',
      'penpot.patch_markup',
      'penpot.search',
      'penpot.set_markup',
    ]);
  });

  test('every tool has description and JSON-schema parameters', () => {
    for (const t of ALL) {
      assert.ok(t.description.length > 10, `${t.name} description too short`);
      assert.equal((t.parameters as any).type, 'object');
    }
  });

  test('ToolRegistry includes all 7 penpot tools', () => {
    const reg = new ToolRegistry();
    const got = reg.getAll().map(t => t.name).filter(n => n.startsWith('penpot.')).sort();
    assert.equal(got.length, 7);
    const defs = reg.getDefinitions(got);
    assert.equal(defs.length, 7);
    for (const d of defs) assert.equal(d.type, 'function');
  });
});

// ── 2. Input validation ──

describe('penpot tools — input validation', () => {
  const cases: Array<[string, any, any]> = [
    ['set_markup empty', new PenpotSetMarkupTool(), { markup: '' }],
    ['set_markup wrong type', new PenpotSetMarkupTool(), { markup: 42 }],
    ['set_markup missing', new PenpotSetMarkupTool(), {}],
    ['patch_markup missing', new PenpotPatchMarkupTool(), {}],
    ['mutate_shape no shapeId', new PenpotMutateShapeTool(), { fields: { x: 1 } }],
    ['mutate_shape empty fields', new PenpotMutateShapeTool(), { shapeId: 'abc', fields: {} }],
    ['export_shape bad format', new PenpotExportShapeTool(), { shapeId: 'a', format: 'gif' }],
    ['export_shape no shapeId', new PenpotExportShapeTool(), { format: 'png' }],
    ['search empty query', new PenpotSearchTool(), { query: '' }],
    ['search bad limit', new PenpotSearchTool(), { query: 'foo', limit: -1 }],
    ['overview extra key', new PenpotHighLevelOverviewTool(), { stray: true }],
    ['list_shapes bad filter type', new PenpotListShapesTool(), { filter: { type: 42 } }],
  ];

  for (const [name, tool, badInput] of cases) {
    test(name, async () => {
      const res: ToolResult = await tool.execute(badInput, stubCtx);
      assert.equal(res.success, false, `${name} should fail validation, got: ${JSON.stringify(res)}`);
      assert.ok(res.error, `${name} should have an error message`);
      assert.match(res.error!, /invalid input/, `${name} should report 'invalid input', got: ${res.error}`);
    });
  }
});

// ── 3. Network failure mapping ──

describe('penpot tools — unreachable backend', () => {
  test('set_markup → bridge unreachable error', async () => {
    const res = await new PenpotSetMarkupTool().execute({ markup: 'x' }, stubCtx);
    assert.equal(res.success, false);
    // node fetch error wording varies (ECONNREFUSED on linux, "fetch failed" on darwin)
    assert.match(res.error ?? '', /bridge unreachable|ECONNREFUSED|fetch failed/i);
  });

  test('list_shapes → bridge unreachable error', async () => {
    const res = await new PenpotListShapesTool().execute({}, stubCtx);
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /bridge unreachable|ECONNREFUSED|fetch failed/i);
  });

  test('high_level_overview → MCP unreachable error', async () => {
    const res = await new PenpotHighLevelOverviewTool().execute({}, stubCtx);
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /MCP unreachable|ECONNREFUSED|fetch failed/i);
  });

  test('export_shape png → MCP unreachable error', async () => {
    const res = await new PenpotExportShapeTool().execute({ shapeId: 'abc', format: 'png' }, stubCtx);
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /MCP unreachable|ECONNREFUSED|fetch failed/i);
  });

  test('export_shape pdf → upstream-unsupported error (does not reach MCP)', async () => {
    const res = await new PenpotExportShapeTool().execute({ shapeId: 'abc', format: 'pdf' }, stubCtx);
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /pdf export not supported/);
  });
});
