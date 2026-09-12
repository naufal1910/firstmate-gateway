import { randomUUID } from 'node:crypto';

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

export interface GatewayErrorOptions extends ErrorOptions {
  /** Correlates the error with the Gateway operation that produced it. */
  readonly requestId?: string;
}

export interface GatewayErrorPayload {
  readonly code: GatewayErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly details?: SafeErrorDetails;
}

export class GatewayError extends Error {
  public readonly requestId: string;

  public constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly details?: SafeErrorDetails,
    options?: GatewayErrorOptions,
  ) {
    super(message, options);
    this.name = 'GatewayError';
    this.requestId = options?.requestId ?? randomUUID();
  }

  public toJSON(): GatewayErrorPayload {
    return {
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/** Rebinds a lower-level Gateway error to its enclosing operation. */
export function withRequestId(error: unknown, requestId: string): GatewayError {
  if (error instanceof GatewayError) {
    if (error.requestId === requestId) return error;
    return new GatewayError(error.code, error.message, error.details, { requestId, cause: error });
  }

  return new GatewayError('INTERNAL_ERROR', 'unexpected Gateway failure', undefined, {
    requestId,
    cause: error instanceof Error ? error : undefined,
  });
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError;
}
