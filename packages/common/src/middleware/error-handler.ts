import {
  AppError,
  ErrorCode,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  UnsupportedMediaTypeError,
  isAppError,
  toAppError,
} from '../errors/index.js';
import { fail } from '../response/index.js';
import type { FastifyError, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

const isFastifyError = (error: unknown): error is FastifyError =>
  error instanceof Error && 'code' in error && typeof error.code === 'string';

/** Converts anything thrown in a request into an AppError. */
export const normalizeError = (error: unknown): AppError => {
  if (isAppError(error)) return error;

  if (isFastifyError(error) && error.statusCode !== undefined && error.statusCode < 500) {
    if (error.statusCode === 429) return new RateLimitError();
    if (error.statusCode === 404) return new NotFoundError('Route');
    if (error.statusCode === 413) return new PayloadTooLargeError(error.message, { cause: error });
    if (error.statusCode === 415)
      return new UnsupportedMediaTypeError(error.message, { cause: error });
    // Malformed JSON, wrong content type, body too large, etc.
    return new AppError(ErrorCode.BAD_REQUEST, error.message, error.statusCode, {
      cause: error,
    });
  }

  return toAppError(error);
};

const plugin: FastifyPluginCallback = (app, _opts, done) => {
  app.setErrorHandler((error, request, reply) => {
    const appError = normalizeError(error);

    if (appError.isOperational) {
      request.log.warn({ err: appError, code: appError.code }, appError.message);
    } else {
      request.log.error(
        { err: appError.cause ?? appError, code: appError.code },
        'unhandled error',
      );
    }

    return reply.status(appError.statusCode).send(fail(appError, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError('Route');
    return reply.status(404).send(fail(error, request.id));
  });

  done();
};

/** Global error + 404 handler: every error leaves as the standard `fail()` envelope. */
export const errorHandlerPlugin = fp(plugin, { name: '@farmx/error-handler' });
