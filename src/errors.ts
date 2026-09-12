export const GATEWAY_ERROR_CODES = [
  'CONFIG_NOT_FOUND',
  'CONFIG_INVALID',
  'HERDR_NOT_FOUND',
  'HERDR_SESSION_NOT_FOUND',
  'HERDR_SESSION_NOT_RUNNING',
  'HERDR_UNAVAILABLE',
  'HERDR_INCOMPATIBLE',
  'TARGET_NOT_CONFIGURED',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'INVALID_ARGUMENT',
  'INTERNAL_ERROR',
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export type SafeErrorDetails = Readonly<Record<string, boolean | number | string | null>>;

export class GatewayError extends Error {
  public constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly details?: SafeErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GatewayError';
  }
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError;
}
