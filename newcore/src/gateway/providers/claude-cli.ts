// ═══════════════════════════════════════════════════════════════
// OpenGravity — Claude CLI Provider
// Subprocesses the local `claude` CLI (which carries its own OAuth) to
// get real Claude responses without needing ANTHROPIC_API_KEY.
//
// Invocation: `claude -p "<prompt>"`  (optionally `--model <alias>`)
// Verified against claude 2.x: `-p` prints the response to stdout and exits
// 0 cleanly. Model aliases `haiku` / `sonnet` are accepted; `default` omits
// the flag and lets the CLI choose.
// ═══════════════════════════════════════════════════════════════

import { execSync, spawn } from 'child_process';
import type {
  ModelProvider, ModelInfo, CompletionRequest, CompletionResponse,
} from '../../types/index.js';

const CLI_TIMEOUT_MS = 60_000;

export class ClaudeCliProvider implements ModelProvider {
  readonly name = 'claude-cli';
  readonly models: ModelInfo[] = [
    {
      id: 'claude-cli/haiku',
      provider: 'claude-cli',
      name: 'Claude Haiku (CLI)',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsTools: false,        // CLI subprocess; no native tool-use roundtrip
      supportsStreaming: false,
      costPerInputToken: 0,        // CLI uses OAuth subscription; no per-call billing here
      costPerOutputToken: 0,
    },
    {
      id: 'claude-cli/sonnet',
      provider: 'claude-cli',
      name: 'Claude Sonnet (CLI)',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsTools: false,
      supportsStreaming: false,
      costPerInputToken: 0,
      costPerOutputToken: 0,
    },
    {
      id: 'claude-cli/default',
      provider: 'claude-cli',
      name: 'Claude (CLI default)',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsTools: false,
      supportsStreaming: false,
      costPerInputToken: 0,
      costPerOutputToken: 0,
    },
  ];

  private cliPath: string | null = null;

  constructor() {
    try {
      // `which claude` — captures PATH lookup.
      this.cliPath = execSync('which claude', { encoding: 'utf-8' }).trim() || null;
    } catch {
      this.cliPath = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.cliPath !== null;
  }

  /**
   * Flatten the chat history into a single prompt the CLI can consume.
   * The CLI doesn't have a multi-turn API in -p mode, so we serialize:
   *   [SYSTEM]: …
   *   [USER]: …
   *   [ASSISTANT]: …
   *   [USER]: …
   * The last role marker primes the model to produce an assistant reply.
   */
  private buildPrompt(request: CompletionRequest): string {
    const parts: string[] = [];
    for (const m of request.messages) {
      const tag = m.role.toUpperCase();
      parts.push(`[${tag}]: ${m.content}`);
    }
    return parts.join('\n\n');
  }

  /** Strip the `claude-cli/` prefix; return null for `default` (no flag). */
  private resolveModelFlag(modelId: string): string | null {
    const bare = modelId.startsWith('claude-cli/') ? modelId.slice('claude-cli/'.length) : modelId;
    if (!bare || bare === 'default') return null;
    return bare;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.cliPath) {
      throw new Error('claude CLI not on PATH; install or fix PATH to use claude-cli provider');
    }
    const start = Date.now();
    const prompt = this.buildPrompt(request);
    const modelFlag = this.resolveModelFlag(request.model);

    const args: string[] = ['-p'];
    if (modelFlag) args.push('--model', modelFlag);
    args.push(prompt);

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.cliPath!, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
      }, CLI_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`claude CLI exited ${code}: ${err.trim().slice(0, 500)}`));
          return;
        }
        resolve(out);
      });
    });

    const content = stdout.trim();
    return {
      id: `claude-cli-${Date.now()}`,
      model: request.model,
      content,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
      latencyMs: Date.now() - start,
    };
  }
}
