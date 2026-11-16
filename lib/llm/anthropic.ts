import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  InvalidProviderResponseError,
  ProviderError,
  ProviderRefusalError,
  ProviderTimeoutError,
  type ExtractionProvider,
  type StructuredRequest,
  type StructuredResult,
} from "./types";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Models that accept the server-side `fallbacks: "default"` parameter: if the
// model declines a request, the API re-runs it on a fallback model in the same
// call. Haiku 5.5 has no server-side fallback, so it is called without.
const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);

export interface AnthropicProviderOptions {
  model: string;
  effort: Effort;
  timeoutMs: number;
  client?: Anthropic; // injectable for tests
}

export class AnthropicProvider implements ExtractionProvider {
  readonly id = "anthropic";
  readonly model: string;
  private readonly effort: Effort;
  private readonly timeoutMs: number;
  private client: Anthropic | undefined;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.effort = options.effort;
    this.timeoutMs = options.timeoutMs;
    this.client = options.client;
  }

  // Created on first use so a missing key surfaces as a FAILED note with a
  // clear reason, not a crash. Credentials resolve from ANTHROPIC_API_KEY.
  private getClient(): Anthropic {
    if (!this.client) {
      try {
        this.client = new Anthropic({ maxRetries: 2 });
      } catch (err) {
        throw new ProviderError(`Anthropic client not configured: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.client;
  }

  async generate(request: StructuredRequest): Promise<StructuredResult> {
    const client = this.getClient();
    const started = Date.now();
    const useFallback = SERVER_FALLBACK_MODELS.has(this.model);

    let response;
    try {
      response = await client.beta.messages.parse(
        {
          model: this.model,
          max_tokens: 16000,
          system: [
            { type: "text", text: request.system },
            // Breakpoint after the per-MR shortlist: system + shortlist are
            // reused across all of an MR's notes.
            { type: "text", text: request.context, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: request.user }],
          output_config: {
            format: betaZodOutputFormat(request.schema),
            effort: this.effort,
          },
          ...(useFallback
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
        },
        { timeout: this.timeoutMs }
      );
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        throw new ProviderTimeoutError(`Anthropic request timed out after ${this.timeoutMs}ms`);
      }
      if (err instanceof Anthropic.APIError) {
        throw new ProviderError(`Anthropic API error ${err.status ?? ""}: ${err.message}`, err.status);
      }
      // The SDK throws when the response can't be parsed into the schema.
      throw new InvalidProviderResponseError(
        err instanceof Error ? err.message : "Unparseable provider response",
        null
      );
    }

    const latencyMs = Date.now() - started;
    if (response.stop_reason === "refusal") {
      throw new ProviderRefusalError(
        `Model declined the request${response.stop_details ? ` (${response.stop_details.category ?? "uncategorized"})` : ""}`
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new InvalidProviderResponseError("Response hit max_tokens before completing", null);
    }

    const rawText =
      response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("") || null;

    let output: unknown = response.parsed_output ?? null;
    if (output === null && rawText) {
      try {
        output = JSON.parse(rawText);
      } catch {
        throw new InvalidProviderResponseError("Response was not valid JSON", rawText);
      }
    }
    if (output === null) {
      throw new InvalidProviderResponseError("Response had no structured output", rawText);
    }

    return {
      output,
      rawText,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      latencyMs,
    };
  }
}
