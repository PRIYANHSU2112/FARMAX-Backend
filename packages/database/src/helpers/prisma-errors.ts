import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '@farmx/common/errors';

/** Shape shared by PrismaClientKnownRequestError / PrismaClientInitializationError. */
interface PrismaErrorLike {
  name: string;
  message: string;
  code?: unknown;
  errorCode?: unknown;
  meta?: Record<string, unknown>;
}

const PRISMA_ERROR_NAMES = new Set([
  'PrismaClientKnownRequestError',
  'PrismaClientInitializationError',
]);

/** P1001 can't reach DB · P1002 timed out · P1008 op timeout · P1017 conn closed · P2024 pool timeout */
const UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

const isPrismaError = (error: unknown): error is PrismaErrorLike =>
  error instanceof Error && PRISMA_ERROR_NAMES.has(error.name);

/** Prisma error code (`P2002`, ...) of a Prisma error, otherwise `undefined`. */
export const prismaErrorCode = (error: unknown): string | undefined => {
  if (!isPrismaError(error)) return undefined;
  const code = error.code ?? error.errorCode;
  return typeof code === 'string' ? code : undefined;
};

const asStringArray = (value: unknown): string[] | undefined => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  return undefined;
};

/** Fields of a unique-constraint violation (classic engine and driver-adapter shapes). */
export const uniqueViolationFields = (error: unknown): string[] => {
  if (prismaErrorCode(error) !== 'P2002' || !isPrismaError(error)) return [];
  const meta = error.meta ?? {};
  const fromTarget = asStringArray(meta.target);
  if (fromTarget) return fromTarget;

  // Driver adapters: meta.driverAdapterError.cause.constraint.fields
  const adapter = meta.driverAdapterError as
    { cause?: { constraint?: { fields?: unknown } } } | undefined;
  return asStringArray(adapter?.cause?.constraint?.fields) ?? [];
};

/** True when `error` is a unique violation (optionally on a specific field). */
export const isUniqueViolation = (error: unknown, field?: string): boolean =>
  prismaErrorCode(error) === 'P2002' &&
  (field === undefined || uniqueViolationFields(error).includes(field));

/**
 * Maps known Prisma errors to AppErrors (others are returned unchanged):
 * P2002 → 409 Conflict · P2025 → 404 Not found · P2003 → 400 invalid reference ·
 * P2034 → 409 write conflict (retry) · connection/pool errors → 503.
 */
export const mapPrismaError = (error: unknown): unknown => {
  const code = prismaErrorCode(error);
  if (code === undefined) return error;
  const meta = (error as PrismaErrorLike).meta ?? {};

  switch (code) {
    case 'P2002': {
      const fields = uniqueViolationFields(error);
      const message =
        fields.length > 0 ? `${fields.join(', ')} already exists` : 'Resource already exists';
      return new ConflictError(message, { cause: error, details: { fields } });
    }
    case 'P2025': {
      const model = typeof meta.modelName === 'string' ? meta.modelName : 'Record';
      return new NotFoundError(model, { cause: error });
    }
    case 'P2003':
      return new BadRequestError('Referenced record does not exist', { cause: error });
    case 'P2034':
      return new ConflictError('Concurrent update conflict, please retry', { cause: error });
    default:
      if (UNAVAILABLE_CODES.has(code)) {
        return new ServiceUnavailableError('Database temporarily unavailable', {
          cause: error,
          isOperational: false,
        });
      }
      return error;
  }
};

/** Runs a database call and rethrows Prisma errors as AppErrors. Use in repositories. */
export const withPrismaErrors = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    const mapped = mapPrismaError(error);
    throw mapped instanceof Error ? mapped : error;
  }
};
