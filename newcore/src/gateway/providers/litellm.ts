// ═══════════════════════════════════════════════════════════════
// OpenGravity — LiteLLM Gateway Provider
// Talks to the Accelerators/02-gateway LiteLLM proxy (OpenAI-compatible
// API) on localhost:4000. Fetches the model list dynamically so newcore
// adapts to whatever the gateway is configured to route.
// ═══════════════════════════════════════════════════════════════

import type {
  ModelProvider, ModelInfo, CompletionRequest, CompletionResponse,
} from '../../types/index.js';

export class LitellmProvider implements ModelProvider {
  readonly name = 'litellm';
  models: ModelInfo[] = [];
  private baseUrl: string;
  private apiKey: string;
  private hydrated = false;

  constructor(baseUrl: string, apiKey: string) {
    // Accept either http://host:4000 or http://host:4000/v1; normalize to /v1.
    const stripped = baseUrl.replace(/\/+$/, '');
    this.baseUrl = stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
    this.apiKey = apiKey || 'EMPTY';
  }

  async isAvailable(): Promise<boolean> {
    // We treat the provider as available iff the gateway responds to a
    // lightweight probe. Hydration is allowed to use the fallback model list
    // if /v1/models is empty, but if the gateway itself is down we should
    // surface that so the fallback chain picks the next provider.
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        // 2s — fast fail; the gateway is local
        signal: AbortSignal.timeout(2_000),
      });
      // 200, 401, 403 all mean "gateway is up" (auth errors still imply liveness).
      if (!r.ok && r.status >= 500) return false;
      await this.hydrateModels();
      return this.models.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Pull the model list from the gateway's /v1/models endpoint and convert
   * to ModelInfo. We don't know real cost/context-window from the gateway,
   * so use conservative defaults (gateway routes by alias; the actual model
   * behind it may vary). Idempotent — hydration happens at most once
   * unless reset via `forceHydrate()`.
   */
  /**
   * Confirmed-loaded gateway aliases we hardcode as a fallback when /v1/models
   * comes back empty (which can happen when the master key is scoped narrowly
   * or the gateway hasn't synced its catalog yet). Any of these will route to
   * a real provider when actually used in /chat/completions.
   */
  private static readonly FALLBACK_MODELS = [
    'groq-llama-8b',   // fast SLM
    'groq-llama-70b',  // balanced
    'or-deepseek-r1',  // reasoning
    'or-llama-70b',    // general
    'or-qwen-72b',     // general
  ];

  async hydrateModels(): Promise<void> {
    if (this.hydrated) return;
    let ids: string[] = [];
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      });
      if (r.ok) {
        const payload = await r.json() as { data?: Array<{ id: string }> };
        ids = (payload.data ?? []).map(m => m.id);
      }
    } catch {
      // network/parse failure → fall through to fallback list
    }
    if (ids.length === 0) ids = [...LitellmProvider.FALLBACK_MODELS];

    this.models = ids.map(id => ({
      id,
      provider: 'litellm',
      name: id,
      contextWindow: 32_768,        // conservative default; gateway routes
      maxOutputTokens: 8_192,       // conservative default
      supportsTools: true,          // most modern models do; gateway forwards
      supportsStreaming: true,
      costPerInputToken: 0,         // gateway tracks cost; we don't double-account
      costPerOutputToken: 0,
    }));
    this.hydrated = true;
  }

  /** Allow callers (e.g. /info handler) to refresh after the gateway restarts. */
  async forceHydrate(): Promise<void> {
    this.hydrated = false;
    await this.hydrateModels();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const start = Date.now();
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.name) msg.name = m.name;
        if (m.toolCallId) msg.tool_call_id = m.toolCallId;
        if (m.toolCalls) msg.tool_calls = m.toolCalls;
        return msg;
      }),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
    };
    if (request.tools?.length) { body.tools = request.tools; body.tool_choice = 'auto'; }
    if (request.stop) body.stop = request.stop;

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`LiteLLM gateway error (${resp.status}): ${await resp.text()}`);
    }
    const data = await resp.json() as any;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`LiteLLM gateway returned no choices: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return {
      id: data.id,
      model: data.model,
      content: choice.message?.content ?? '',
      toolCalls: choice.message?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      latencyMs: Date.now() - start,
    };
  }
}
