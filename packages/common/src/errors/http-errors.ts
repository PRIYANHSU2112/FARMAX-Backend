import { AppError, type AppErrorOptions } from './app-error.js';
import { ErrorCode } from './error-codes.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', options?: AppErrorOptions) {
    super(ErrorCode.BAD_REQUEST, message, 400, options);
  }
}

export class ValidationError extends AppError {
  constructor(issues: ValidationIssue[], message = 'Validation failed') {
    super(ErrorCode.VALIDATION_ERROR, message, 422, { details: { issues } });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', options?: AppErrorOptions) {
    super(ErrorCode.UNAUTHORIZED, message, 401, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action',
    options?: AppErrorOptions,
  ) {
    super(ErrorCode.FORBIDDEN, message, 403, options);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', options?: AppErrorOptions) {
    super(ErrorCode.NOT_FOUND, `${resource} not found`, 404, options);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', options?: AppErrorOptions) {
    super(ErrorCode.CONFLICT, message, 409, options);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large', options?: AppErrorOptions) {
    super(ErrorCode.PAYLOAD_TOO_LARGE, message, 413, options);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported media type', options?: AppErrorOptions) {
    super(ErrorCode.UNSUPPORTED_MEDIA_TYPE, message, 415, options);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds?: number) {
    super(ErrorCode.RATE_LIMITED, 'Too many requests', 429, {
      details: retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
    });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error', options?: AppErrorOptions) {
    super(ErrorCode.INTERNAL_ERROR, message, 500, { isOperational: false, ...options });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', options?: AppErrorOptions) {
    super(ErrorCode.SERVICE_UNAVAILABLE, message, 503, options);
  }
}

/** A dependency we call (Razorpay, email provider, another service) failed. */
export class ExternalServiceError extends AppError {
  constructor(service: string, options?: AppErrorOptions) {
    super(ErrorCode.EXTERNAL_SERVICE_ERROR, `Upstream service failed: ${service}`, 502, {
      isOperational: false,
      ...options,
    });
  }
}
