import { isAbsolute, normalize, resolve } from 'node:path';

import { GatewayError } from './errors.js';
import type { TargetConfig } from './config.js';
import type { AgentStatus, HerdrAgent } from './herdr/protocol.js';

export type CwdEvidence = 'foreground_cwd' | 'cwd';

export interface ResolutionEvidence {
  readonly cwdSource: CwdEvidence;
  readonly weakerCwdEvidence: boolean;
}

export interface ResolvedTarget {
  readonly alias: string;
  readonly herdrSession: string;
  readonly agent: string;
  readonly paneId: string;
  readonly canonicalCwd: string;
  readonly state: AgentStatus;
  readonly rawState?: string;
  readonly evidence: ResolutionEvidence;
}

interface CandidateCwd {
  readonly canonicalCwd: string;
  readonly source: CwdEvidence;
}

function canonicalAbsolutePath(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || !isAbsolute(value)) {
    return undefined;
  }
  return normalize(resolve(value));
}

function candidateCwd(agent: HerdrAgent): CandidateCwd | undefined {
  if (agent.foregroundCwd !== undefined) {
    const foregroundCwd = canonicalAbsolutePath(agent.foregroundCwd);
    return foregroundCwd === undefined
      ? undefined
      : { canonicalCwd: foregroundCwd, source: 'foreground_cwd' };
  }

  const cwd = canonicalAbsolutePath(agent.cwd);
  if (cwd !== undefined) {
    return { canonicalCwd: cwd, source: 'cwd' };
  }

  return undefined;
}

function resolutionDetails(
  target: TargetConfig,
  candidates: readonly HerdrAgent[],
): { readonly expectedAgent: string; readonly candidateCount: number; readonly agentKindMatches: number } {
  return {
    expectedAgent: target.agent,
    candidateCount: candidates.length,
    agentKindMatches: candidates.filter((candidate) => candidate.agent === target.agent).length,
  };
}

export function resolveTarget(target: TargetConfig, agents: readonly HerdrAgent[]): ResolvedTarget {
  const expectedCwd = canonicalAbsolutePath(target.firstmateHome);
  if (expectedCwd === undefined) {
    throw new GatewayError('CONFIG_INVALID', 'configured FirstMate home is not an absolute path');
  }

  const matches = agents.filter((agent) => {
    if (agent.agent !== target.agent) {
      return false;
    }
    return candidateCwd(agent)?.canonicalCwd === expectedCwd;
  });

  if (matches.length === 0) {
    throw new GatewayError(
      'TARGET_NOT_FOUND',
      'no current Herdr agent matches the configured target identity',
      resolutionDetails(target, agents),
    );
  }
  if (matches.length > 1) {
    throw new GatewayError(
      'TARGET_AMBIGUOUS',
      'multiple current Herdr agents match the configured target identity',
      resolutionDetails(target, agents),
    );
  }

  const match = matches[0] as HerdrAgent;
  const cwd = candidateCwd(match) as CandidateCwd;
  return {
    alias: target.alias,
    herdrSession: target.herdrSession,
    agent: target.agent,
    paneId: match.paneId,
    canonicalCwd: cwd.canonicalCwd,
    state: match.agentStatus,
    ...(match.rawAgentStatus === undefined ? {} : { rawState: match.rawAgentStatus }),
    evidence: {
      cwdSource: cwd.source,
      weakerCwdEvidence: cwd.source === 'cwd',
    },
  };
}
