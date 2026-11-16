import { AnthropicProvider, type Effort } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type { ExtractionProvider } from "./types";

export * from "./types";

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "medium";
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Env var holding each provider's API key (checked by the eval runner). */
export const API_KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ProviderConfig {
  provider?: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
}

/**
 * The one place that maps config -> provider. Adding a provider = implement
 * ExtractionProvider in lib/llm/<name>.ts and add a case here.
 */
export function createProvider(config: ProviderConfig = {}): ExtractionProvider {
  const provider = config.provider ?? process.env.LLM_PROVIDER ?? DEFAULT_PROVIDER;
  const model = config.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
  const effortRaw = config.effort ?? process.env.LLM_EFFORT ?? DEFAULT_EFFORT;
  const timeoutMs = config.timeoutMs ?? (Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

  if (!EFFORTS.includes(effortRaw as Effort)) {
    throw new Error(`Unknown LLM effort "${effortRaw}" (expected ${EFFORTS.join(", ")})`);
  }

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider({ model, effort: effortRaw as Effort, timeoutMs });
    case "openai":
      return new OpenAIProvider({ model, effort: effortRaw as Effort, timeoutMs });
    default:
      throw new Error(`Unknown LLM provider "${provider}"`);
  }
}
