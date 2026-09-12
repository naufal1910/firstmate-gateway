export const VERSION = '0.3.0';

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
  DEFAULT_READ_COUNT,
  DEFAULT_READ_LINES,
  DEFAULT_READ_SOURCE,
  MAX_PROMPT_BYTES,
  MAX_READ_COUNT,
  MAX_READ_LINES,
  MIN_READ_COUNT,
  MIN_READ_LINES,
  isReadSource,
  type GatewayDependencies,
  type GatewayInvocationOptions,
  type ReadInput,
  type ReadMode,
  type ReadResult,
  type RawReadResult,
  type SemanticReadResult,
  type SendPromptInput,
  type SendPromptResult,
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
  type HerdrAgentClient,
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

export {
  selectSemanticReader,
  type SemanticReadInput,
  type SemanticReader,
  type SemanticReaderProvider,
} from './semantic.js';
