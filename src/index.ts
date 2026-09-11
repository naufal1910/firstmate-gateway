export const VERSION = '0.1.0';

export {
  ConfigError,
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
