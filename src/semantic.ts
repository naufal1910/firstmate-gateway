import type { TargetConfig } from './config.js';
import type { ResolvedTarget } from './target.js';

/**
 * Context supplied only after a target has been dynamically resolved for a
 * semantic read. Providers must use a validated structured source; raw Herdr
 * terminal text is intentionally not part of this abstraction.
 */
export interface SemanticReadInput {
  readonly target: TargetConfig;
  readonly resolvedTarget: ResolvedTarget;
  readonly requestId: string;
}

export interface SemanticReadResult {
  /** Structured semantic response text. It is never logged or persisted here. */
  readonly text: string;
}

/**
 * A harness-specific semantic capability. Providers are opt-in and selected
 * by configured target metadata before Gateway performs the live resolution.
 */
export interface SemanticReaderProvider {
  readonly name: string;
  supports(target: TargetConfig): boolean;
  read(input: SemanticReadInput): Promise<SemanticReadResult>;
}

/** Alias for clients that refer to the capability as a semantic reader. */
export type SemanticReader = SemanticReaderProvider;

export function selectSemanticReader(
  providers: readonly SemanticReaderProvider[],
  target: TargetConfig,
): SemanticReaderProvider | undefined {
  return providers.find((provider) => provider.supports(target));
}
