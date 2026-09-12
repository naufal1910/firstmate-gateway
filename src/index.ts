export const VERSION = '0.2.0';

export {
  ConfigError,
  ConfigNotFoundError,
  defaultConfigPath,
  loadConfig,
  loadConfigFile,
  loadConfigFileSync,
  parseConfig,
  validateConfig,
  type GatewayConfig,
  type TargetConfig,
} from './config.js';

export {
  GatewayError,
  GATEWAY_ERROR_CODES,
  type GatewayErrorCode,
  type GatewayErrorOptions,
  type GatewayErrorPayload,
  type SafeErrorDetails,
  withRequestId,
} from './errors.js';

export {
  Gateway,
  createRequestId,
  type DoctorCheck,
  type DoctorReport,
  type GatewayDependencies,
  type GatewayInvocationOptions,
  type TargetStatus,
  type TargetSummary,
} from './gateway.js';

export {
  HerdrSessionLocator,
  parseSessionList,
  type HerdrCommandOptions,
  type HerdrCommandResult,
  type HerdrCommandRunner,
  type HerdrSessionEndpoint,
  type HerdrSessionInfo,
  type HerdrSessionLocatorOptions,
  type HerdrSocketValidator,
} from './herdr/session.js';

export {
  resolveTarget,
  type CwdEvidence,
  type ResolutionEvidence,
  type ResolvedTarget,
} from './target.js';

export {
  EXPECTED_HERDR_PROTOCOL,
  MINIMUM_HERDR_PROTOCOL,
  HerdrCompatibilityError,
  HerdrError,
  HerdrMalformedResponseError,
  HerdrProtocolError,
  HerdrSocketClient,
  HerdrTransportError,
  createUnixSocketExchange,
  type AgentReadOptions,
  type AgentStatus,
  type HerdrAgent,
  type HerdrCompatibilityReport,
  type HerdrExchange,
  type HerdrPing,
  type HerdrRead,
  type HerdrRequest,
  type HerdrSocketClientOptions,
  type ReadFormat,
  type ReadSource,
  type RequiredHerdrMethod,
} from './herdr/protocol.js';
