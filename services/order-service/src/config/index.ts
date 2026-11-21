import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export interface OrderConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  REDIS_CACHE_URL: string;
  /** OpenAPI spec at /api-docs.json (merged into the gateway's single Swagger UI). */
  DOCS_ENABLED?: boolean;
  /** Access tokens are verified with auth-service's PUBLIC key. */
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  /** auth-service base URL for the permission-cache fallback (`/internal/access`). */
  AUTH_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). */
  INTERNAL_SERVICE_TOKEN?: string;
  /** RabbitMQ: outbox relay + consumers. */
  RABBITMQ_URL: string;
  /** Run the outbox relay and event consumers (off in tests). */
  EVENTS_ENABLED: boolean;
  /** redis-queue: BullMQ (payment timeout, stuck placements). */
  REDIS_QUEUE_URL: string;
  /** Run the BullMQ jobs (off in tests). */
  JOBS_ENABLED: boolean;
  /** Internal service base URLs (service token; never through the gateway). */
  INVENTORY_SERVICE_URL: string;
  PAYMENT_SERVICE_URL: string;
  /** wallet-service `/internal/wallet/*` (wallet checkout balance pre-check). */
  WALLET_SERVICE_URL: string;
  USER_SERVICE_URL: string;
  /** GST state code of the supplying node (mother warehouse); decides CGST+SGST vs IGST. */
  SELLER_STATE_CODE: string;
  /**
   * Seller of record printed on tax documents (required in prod; outside prod an invoice cannot
   * be issued until they are set). The GSTIN's state must equal SELLER_STATE_CODE.
   */
  SELLER_GSTIN?: string;
  SELLER_LEGAL_NAME?: string;
  /** One line, e.g. "Plot 12, APIIC IDA, Nuzvid, Eluru, Andhra Pradesh 521201". */
  SELLER_ADDRESS?: string;
  /** Document number prefixes (1–3 letters, so numbers stay ≤ 16 characters): FX/2627/0000001. */
  INVOICE_SERIES: string;
  CREDIT_NOTE_SERIES: string;
  /** Inter-state B2C invoices above this (₹) are reported as GSTR-1 B2CL. */
  B2CL_THRESHOLD: string;
  /**
   * Where invoice PDFs are stored: `spaces` (DigitalOcean Spaces, PRIVATE objects, signed
   * download URLs) or `local` (a directory; dev / tests only, REFUSED when APP_ENV=prod).
   */
  INVOICE_STORAGE: 'spaces' | 'local';
  INVOICE_LOCAL_DIR: string;
  /** DigitalOcean Spaces (same variables as media-service). Required for `spaces`. */
  AWS_ENDPOINT?: string;
  AWS_REGION?: string;
  AWS_BUCKET_NAME?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  /** Optional PNG / JPEG logo printed on invoices (else the seller name as a wordmark). */
  INVOICE_LOGO_PATH?: string;
  /** PDFs rendered in parallel per replica; attempts before FAILED (admin retry). */
  INVOICE_PDF_CONCURRENCY: number;
  INVOICE_PDF_MAX_ATTEMPTS: number;
  /** Cold-chain freight & packaging (₹) when any line is CC_REF / CC_FRZ. */
  FREIGHT_COLD_CHAIN: string;
  /** Freight (₹) otherwise. */
  FREIGHT_STANDARD: string;
  /** GST rate (%) and SAC code on freight. */
  FREIGHT_GST_RATE: string;
  FREIGHT_SAC_CODE: string;
  /** Max distinct lines in one cart. */
  CART_MAX_LINES: number;
  /** Guest carts expire this many days after their last change. */
  CART_GUEST_TTL_DAYS: number;
}

const RUPEES = Joi.string().pattern(/^\d{1,7}(\.\d{1,2})?$/);

const schema = Joi.object<OrderConfig>({
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DB_POOL_SIZE: Joi.number().integer().min(1).max(50).default(10),
  REDIS_CACHE_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6379'),
  DOCS_ENABLED: Joi.boolean().truthy('1').falsy('0'),
  JWT_PUBLIC_KEY: Joi.string()
    .base64()
    .when('APP_ENV', { is: Joi.valid('dev', 'prod'), then: Joi.required() }),
  JWT_KEY_ID: Joi.string().default('dev'),
  JWT_ISSUER: Joi.string().default('farmx-auth'),
  JWT_AUDIENCE: Joi.string().default('farmx'),
  AUTH_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3001'),
  INTERNAL_SERVICE_TOKEN: Joi.string().min(32),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean()
    .truthy('1')
    .falsy('0')
    .default((parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test'),
  REDIS_QUEUE_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6380'),
  JOBS_ENABLED: Joi.boolean()
    .truthy('1')
    .falsy('0')
    .default((parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test'),
  INVENTORY_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3008'),
  PAYMENT_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3009'),
  WALLET_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3012'),
  USER_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3006'),
  SELLER_STATE_CODE: Joi.string()
    .pattern(/^\d{2}$/)
    .default('37'),
  SELLER_GSTIN: Joi.string()
    .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .when('APP_ENV', { is: 'prod', then: Joi.required() }),
  SELLER_LEGAL_NAME: Joi.string().max(120).when('APP_ENV', { is: 'prod', then: Joi.required() }),
  SELLER_ADDRESS: Joi.string().max(300).when('APP_ENV', { is: 'prod', then: Joi.required() }),
  INVOICE_SERIES: Joi.string()
    .pattern(/^[A-Z]{1,3}$/)
    .default('FX'),
  CREDIT_NOTE_SERIES: Joi.string()
    .pattern(/^[A-Z]{1,3}$/)
    .default('CN'),
  B2CL_THRESHOLD: RUPEES.default('100000.00'),
  // Fails CLOSED in prod: `local` is not allowed there (Joi.override replaces the valid values).
  INVOICE_STORAGE: Joi.string()
    .valid('spaces', 'local')
    .default((parent: { APP_ENV?: string }) => (parent.APP_ENV === 'prod' ? 'spaces' : 'local'))
    .when('APP_ENV', {
      is: 'prod',
      then: Joi.valid(Joi.override, 'spaces').messages({
        'any.only': 'INVOICE_STORAGE=local is not allowed when APP_ENV=prod',
      }),
    }),
  INVOICE_LOCAL_DIR: Joi.string().default('.data/invoices'),
  ...Object.fromEntries(
    [
      'AWS_ENDPOINT',
      'AWS_REGION',
      'AWS_BUCKET_NAME',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ].map((key) => [
      key,
      Joi.string().when('INVOICE_STORAGE', { is: 'spaces', then: Joi.required() }),
    ]),
  ),
  INVOICE_LOGO_PATH: Joi.string(),
  INVOICE_PDF_CONCURRENCY: Joi.number().integer().min(1).max(16).default(2),
  INVOICE_PDF_MAX_ATTEMPTS: Joi.number().integer().min(1).max(20).default(6),
  FREIGHT_COLD_CHAIN: RUPEES.default('495.00'),
  FREIGHT_STANDARD: RUPEES.default('0.00'),
  FREIGHT_GST_RATE: Joi.string()
    .pattern(/^\d{1,2}(\.\d{1,2})?$/)
    .default('18'),
  FREIGHT_SAC_CODE: Joi.string()
    .pattern(/^\d{4,8}$/)
    .default('996511'),
  CART_MAX_LINES: Joi.number().integer().min(1).max(200).default(50),
  CART_GUEST_TTL_DAYS: Joi.number().integer().min(1).max(90).default(30),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads ORDER_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<OrderConfig> =>
  createConfig<OrderConfig>(schema, {
    env: { ...env, PORT: env.ORDER_SERVICE_PORT ?? '3007', SERVICE_NAME: 'order-service' },
  });

export const docsEnabled = (config: Pick<OrderConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
