import { describe, expect, it } from 'vitest';

import {
  AppError,
  ConflictError,
  ErrorCode,
  ExternalServiceError,
  NotFoundError,
  ValidationError,
  isAppError,
  toAppError,
} from '../index.js';

describe('AppError hierarchy', () => {
  it('sets code, status, name and operational flag', () => {
    const err = new NotFoundError('User');
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe('NotFoundError');
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('User not found');
    expect(err.isOperational).toBe(true);
  });

  it('marks 5xx upstream errors as non-operational', () => {
    const err = new ExternalServiceError('razorpay');
    expect(err.statusCode).toBe(502);
    expect(err.isOperational).toBe(false);
  });

  it('carries validation issues in details', () => {
    const err = new ValidationError([{ path: 'email', message: 'must be a valid email' }]);
    expect(err.statusCode).toBe(422);
    expect(err.toJSON()).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: { issues: [{ path: 'email', message: 'must be a valid email' }] },
    });
  });

  it('toJSON never leaks the cause', () => {
    const err = new ConflictError('Email taken', { cause: new Error('P2002 unique constraint') });
    expect(err.cause).toBeInstanceOf(Error);
    expect(JSON.stringify(err)).not.toContain('P2002');
  });
});

describe('toAppError', () => {
  it('returns AppErrors unchanged', () => {
    const err = new NotFoundError();
    expect(toAppError(err)).toBe(err);
  });

  it('wraps unknown errors as a generic non-operational 500', () => {
    const wrapped = toAppError(new TypeError('x is undefined'));
    expect(isAppError(wrapped)).toBe(true);
    expect(wrapped.statusCode).toBe(500);
    expect(wrapped.message).toBe('Internal server error');
    expect(wrapped.isOperational).toBe(false);
    expect(wrapped.cause).toBeInstanceOf(TypeError);
  });
});
