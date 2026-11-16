import type { z } from "zod";

// Provider-neutral contract. lib/extract.ts and the eval runner only see this
// interface, so swapping provider/model is a config change (LLM_PROVIDER,
// LLM_MODEL), and the eval can compare models on identical inputs.

export interface StructuredRequest {
  system: string; // stable instructions (cacheable)
  context: string; // per-MR shortlist (cacheable per MR)
  user: string; // the note
  schema: z.ZodType; // expected output shape
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredResult {
  output: unknown; // parsed JSON, NOT yet trusted — caller re-validates with Zod
  rawText: string | null;
  model: string; // model that actually served the request (may be a fallback)
  usage: Usage;
  latencyMs: number;
}

export interface ExtractionProvider {
  readonly id: string; // "anthropic"
  readonly model: string; // requested model
  generate(request: StructuredRequest): Promise<StructuredResult>;
}

// Typed failures -> Message status FAILED (retryable), never NEEDS_REVIEW.
export class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRefusalError";
  }
}

export class InvalidProviderResponseError extends Error {
  constructor(message: string, readonly raw: unknown) {
    super(message);
    this.name = "InvalidProviderResponseError";
  }
}
