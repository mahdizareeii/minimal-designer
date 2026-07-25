export type DomainErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "VERSION_CONFLICT"
  | "PREVIEW_EXPIRED"
  | "PREVIEW_ALREADY_COMMITTED"
  | "PREVIEW_ENGINE_MISMATCH"
  | "PREVIEW_NOT_COMMITTABLE"
  | "TASK_EXPIRED"
  | "TASK_STATE_CONFLICT"
  | "PAIRING_EXPIRED"
  | "CONNECTION_REVOKED"
  | "IDEMPOTENCY_CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_ASSET"
  | "UNSUPPORTED_DOCUMENT_FEATURE"
  | "AMBIGUOUS_CONTEXT"
  | "PRODUCT_CONTEXT_REQUIRED"
  | "PRODUCT_NOT_EMPTY"
  | "PRODUCT_ARCHIVED"
  | "RESOURCE_STATE_CONFLICT"
  | "DATA_STORE_MISMATCH"
  | "CORE_UNAVAILABLE"
  | "RENDER_FAILED"
  | "RENDER_TIMEOUT"
  | "RATE_LIMITED"
  | "TEMPORARILY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface DomainErrorShape {
  code: DomainErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DomainErrorCode,
    message: string,
    statusCode: number,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = options.retryable ?? false;
    if (options.details) this.details = options.details;
  }

  toJSON(): DomainErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function asDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  return new DomainError("INTERNAL_ERROR", "An internal server error occurred.", 500, {
    retryable: true,
    cause: error,
  });
}

export function domainErrorResult(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { ok: false; error: DomainErrorShape };
} {
  const domainError = asDomainError(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${domainError.code}: ${domainError.message}` }],
    structuredContent: { ok: false, error: domainError.toJSON() },
  };
}
