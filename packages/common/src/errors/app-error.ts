import { ErrorCode } from './error-codes.js';

export interface AppErrorOptions {
  /** Extra, client-safe context (e.g. field-level validation issues). */
  details?: unknown;
  /** Underlying error, kept for logs only, never sent to clients. */
  cause?: unknown;
  /**
   * `true` = expected failure (bad input, not found): log as warn, return its message.
   * `false` = bug or infrastructure failure: log as error, return a generic message.
   */
  isOperational?: boolean;
}

/** Base class for every error the services throw on purpose. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;
  readonly isOperational: boolean;

  constructor(code: ErrorCode, message: string, statusCode: number, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.isOperational = options.isOperational ?? statusCode < 500;
  }

  /** Client-safe representation (no stack, no cause). */
  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

/** Wraps any thrown value into an AppError (unknown errors become a non-operational 500). */
export const toAppError = (error: unknown): AppError => {
  if (isAppError(error)) return error;
  return new AppError(ErrorCode.INTERNAL_ERROR, 'Internal server error', 500, {
    cause: error,
    isOperational: false,
  });
};
