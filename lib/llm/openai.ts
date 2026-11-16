import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  InvalidProviderResponseError,
  ProviderError,
  ProviderRefusalError,
  ProviderTimeoutError,
  type ExtractionProvider,
  type StructuredRequest,
  type StructuredResult,
} from "./types";
import type { Effort } from "./anthropic";

// OpenAI Responses API with Structured Outputs: the JSON schema is generated
// from our Zod schema (strict mode), so the model cannot return malformed or
// off-schema JSON. lib/extract.ts still re-validates with Zod afterwards.
//
// Sampling: temperature 0 where the model accepts it. Reasoning models reject
// `temperature` and take `reasoning.effort` instead; non-reasoning models
// reject `reasoning`. Which one a model takes is learned from the API's own
// 400 on the first call and remembered per model, so no hard-coded model list.

type Sampling = "temperature" | "reasoning" | "none";
const samplingByModel = new Map<string, Sampling>();

/** What a model was actually called with (after any fallback); undefined until its first success. */
export function samplingFor(model: string): Sampling | undefined {
  return samplingByModel.get(model);
}

// Our effort scale -> OpenAI reasoning effort.
const REASONING_EFFORT: Record<Effort, "low" | "medium" | "high" | "xhigh"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

export interface OpenAIProviderOptions {
  model: string;
  effort: Effort;
  timeoutMs: number;
  client?: OpenAI; // injectable for tests
}

export class OpenAIProvider implements ExtractionProvider {
  readonly id = "openai";
  readonly model: string;
  private readonly effort: Effort;
  private readonly timeoutMs: number;
  private client: OpenAI | undefined;

  constructor(options: OpenAIProviderOptions) {
    this.model = options.model;
    this.effort = options.effort;
    this.timeoutMs = options.timeoutMs;
    this.client = options.client;
  }

  // Created on first use so a missing key surfaces as a FAILED note with a
  // clear reason, not a crash. Credentials resolve from OPENAI_API_KEY.
  private getClient(): OpenAI {
    if (!this.client) {
      try {
        this.client = new OpenAI({ maxRetries: 2 });
      } catch (err) {
        throw new ProviderError(`OpenAI client not configured: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.client;
  }

  private body(request: StructuredRequest, sampling: Sampling) {
    return {
      model: this.model,
      // System prompt + per-MR shortlist first and unchanged between notes, so
      // OpenAI's automatic prompt caching reuses the prefix.
      input: [
        { role: "developer" as const, content: request.system },
        { role: "developer" as const, content: request.context },
        { role: "user" as const, content: request.user },
      ],
      text: { format: zodTextFormat(request.schema, "extraction") },
      max_output_tokens: 16000,
      store: false,
      ...(sampling === "temperature" ? { temperature: 0 } : {}),
      ...(sampling === "reasoning" ? { reasoning: { effort: REASONING_EFFORT[this.effort] } } : {}),
    };
  }

  private async call(request: StructuredRequest) {
    const client = this.getClient();
    let sampling = samplingByModel.get(this.model) ?? "temperature";
    // At most: temperature -> reasoning -> none.
    for (;;) {
      try {
        const response = await client.responses.parse(this.body(request, sampling), { timeout: this.timeoutMs });
        samplingByModel.set(this.model, sampling);
        return response;
      } catch (err) {
        const next = nextSampling(err, sampling);
        if (!next) throw err;
        sampling = next;
      }
    }
  }

  async generate(request: StructuredRequest): Promise<StructuredResult> {
    const started = Date.now();
    let response;
    try {
      response = await this.call(request);
    } catch (err) {
      if (err instanceof OpenAI.APIConnectionTimeoutError) {
        throw new ProviderTimeoutError(`OpenAI request timed out after ${this.timeoutMs}ms`);
      }
      if (err instanceof OpenAI.APIError) {
        throw new ProviderError(`OpenAI API error ${err.status ?? ""}: ${err.message}`, err.status);
      }
      // The SDK throws when the output can't be parsed into the schema.
      throw new InvalidProviderResponseError(err instanceof Error ? err.message : "Unparseable provider response", null);
    }
    const latencyMs = Date.now() - started;

    for (const item of response.output) {
      if (item.type === "message") {
        const refusal = item.content.find((c) => c.type === "refusal");
        if (refusal && refusal.type === "refusal") throw new ProviderRefusalError(`Model declined the request: ${refusal.refusal}`);
      }
    }
    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason ?? "unknown";
      if (reason === "content_filter") throw new ProviderRefusalError("Response stopped by content filter");
      throw new InvalidProviderResponseError(`Response incomplete (${reason})`, response.output_text || null);
    }

    const rawText = response.output_text || null;
    let output: unknown = response.output_parsed ?? null;
    if (output === null && rawText) {
      try {
        output = JSON.parse(rawText);
      } catch {
        throw new InvalidProviderResponseError("Response was not valid JSON", rawText);
      }
    }
    if (output === null) throw new InvalidProviderResponseError("Response had no structured output", rawText);

    // OpenAI counts cached tokens inside input_tokens; split them out so cost
    // can price them at the cached rate. Reasoning tokens are in output_tokens.
    const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
    return {
      output,
      rawText,
      model: response.model,
      usage: {
        inputTokens: (response.usage?.input_tokens ?? 0) - cached,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0, // OpenAI caching has no write charge
      },
      latencyMs,
    };
  }
}

/** Given a 400 for an unsupported sampling parameter, the next setting to try. */
export function nextSampling(err: unknown, current: Sampling): Sampling | null {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return null;
  const text = `${err.message} ${JSON.stringify((err as { error?: unknown }).error ?? "")}`.toLowerCase();
  if (current === "temperature" && text.includes("temperature")) return "reasoning";
  if (current === "reasoning" && text.includes("reasoning")) return "none";
  return null;
}
