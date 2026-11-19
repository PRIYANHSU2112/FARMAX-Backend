import { ErrorCode } from '../../errors/index.js';

/** Error statuses a route can list in its docs; each maps to a reusable response component. */
export const ERROR_RESPONSES = {
  400: 'BadRequest',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  409: 'Conflict',
  413: 'PayloadTooLarge',
  415: 'UnsupportedMediaType',
  422: 'ValidationError',
  429: 'RateLimited',
  500: 'InternalError',
  503: 'ServiceUnavailable',
} as const;

export type ErrorStatus = keyof typeof ERROR_RESPONSES;

/** `error.code` returned with each documented status. */
export const ERROR_STATUS_CODES: Readonly<Record<ErrorStatus, ErrorCode>> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.PAYLOAD_TOO_LARGE,
  415: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
  422: ErrorCode.VALIDATION_ERROR,
  429: ErrorCode.RATE_LIMITED,
  500: ErrorCode.INTERNAL_ERROR,
  503: ErrorCode.SERVICE_UNAVAILABLE,
};

/** Response headers sent with an error status (documented on the shared response too). */
export const ERROR_HEADERS: Partial<Record<ErrorStatus, Record<string, unknown>>> = {
  429: {
    'Retry-After': {
      description: 'Seconds to wait before retrying.',
      schema: { type: 'integer', example: 30 },
    },
  },
};

const REQUEST_ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e6f';

/** Builds a response component in the real `fail()` envelope shape, with an example. */
const errorResponse = (
  description: string,
  code: string,
  message: string,
  details?: unknown,
  schema = 'ErrorBody',
) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: `#/components/schemas/${schema}` },
      example: {
        success: false,
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details }),
          requestId: REQUEST_ID,
        },
      },
    },
  },
});

/** Shared OpenAPI components, referenced with `$ref` from every service's spec. */
export const sharedComponents = () => ({
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Access token from the login API. Paste the token only (no "Bearer " prefix).',
    },
  },
  schemas: {
    ErrorBody: {
      type: 'object',
      required: ['success', 'error'],
      properties: {
        success: { type: 'boolean', enum: [false] },
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', enum: Object.values(ErrorCode) },
            message: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
            requestId: {
              type: 'string',
              description: 'Echoed in the X-Request-Id header; quote it in bug reports.',
            },
          },
        },
      },
    },
    ValidationErrorBody: {
      allOf: [
        { $ref: '#/components/schemas/ErrorBody' },
        {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                details: {
                  type: 'object',
                  properties: {
                    issues: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['path', 'message'],
                        properties: {
                          path: { type: 'string', example: 'body.email' },
                          message: { type: 'string', example: '"email" must be a valid email' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
    PaginationMeta: {
      type: 'object',
      required: ['nextCursor', 'limit'],
      properties: {
        nextCursor: {
          type: 'string',
          nullable: true,
          description: 'Pass as `cursor` to get the next page; null on the last page.',
        },
        limit: { type: 'integer', example: 20 },
      },
    },
  },
  responses: {
    BadRequest: errorResponse(
      'Bad request (malformed JSON, wrong content type, or a business rule).',
      ErrorCode.BAD_REQUEST,
      'MFA is mandatory for INTERNAL users',
    ),
    Unauthorized: errorResponse(
      'Missing, invalid or expired access token.',
      ErrorCode.UNAUTHORIZED,
      'Authentication required',
    ),
    Forbidden: errorResponse(
      'Authenticated, but missing the required permission (or a self-action).',
      ErrorCode.FORBIDDEN,
      'You do not have permission to perform this action',
    ),
    NotFound: errorResponse(
      'The resource does not exist (or was deleted).',
      ErrorCode.NOT_FOUND,
      'User not found',
    ),
    Conflict: errorResponse(
      'Conflicts with the current state (duplicate value, last Super Admin, ...).',
      ErrorCode.CONFLICT,
      'email already exists',
      { fields: ['email'] },
    ),
    ValidationError: errorResponse(
      'Request params, query or body failed validation. Every issue is listed.',
      ErrorCode.VALIDATION_ERROR,
      'Validation failed',
      { issues: [{ path: 'body.email', message: '"email" must be a valid email' }] },
      'ValidationErrorBody',
    ),
    PayloadTooLarge: errorResponse(
      'The upload is larger than the limit for its type.',
      ErrorCode.PAYLOAD_TOO_LARGE,
      'image files must be at most 5 MB',
    ),
    UnsupportedMediaType: errorResponse(
      'File type not allowed, or its content does not match its extension / declared type.',
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      'Allowed: JPEG, PNG, WebP, MP4, PDF',
    ),
    ServiceUnavailable: errorResponse(
      'Temporarily unavailable (busy or a dependency is down). Retry shortly.',
      ErrorCode.SERVICE_UNAVAILABLE,
      'Video processing is busy, retry shortly',
    ),
    RateLimited: {
      ...errorResponse(
        'Too many requests. Retry after the `Retry-After` header.',
        ErrorCode.RATE_LIMITED,
        'Too many requests',
        { retryAfterSeconds: 30 },
      ),
      headers: ERROR_HEADERS[429],
    },
    InternalError: errorResponse(
      'Unexpected server error. Details are never exposed.',
      ErrorCode.INTERNAL_ERROR,
      'Internal server error',
    ),
  },
  requestBodies: {
    /** Reusable for the first upload API: `requestBody: { $ref: '#/components/requestBodies/FileUpload' }`. */
    FileUpload: {
      description: 'Single file upload (multipart/form-data).',
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            required: ['file'],
            properties: { file: { type: 'string', format: 'binary' } },
          },
        },
      },
    },
  },
});
