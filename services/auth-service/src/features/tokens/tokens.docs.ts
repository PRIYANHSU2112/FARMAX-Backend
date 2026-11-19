import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

export const AUTH_TAG = 'Auth';

const jwkSchema = Joi.object({
  kty: Joi.string().example('OKP'),
  crv: Joi.string().example('Ed25519'),
  x: Joi.string().example('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'),
  kid: Joi.string().example('2026-11'),
  alg: Joi.string().valid('EdDSA'),
  use: Joi.string().valid('sig'),
}).meta({ className: 'Jwk' });

export const TOKENS_DOCS = {
  jwks: {
    tag: AUTH_TAG,
    summary: 'Public signing keys (JWKS)',
    description: 'Ed25519 public key(s) used to verify access tokens (gateway and other services).',
    public: true,
    success: {
      status: 200,
      description: 'Key set',
      data: Joi.object({ keys: Joi.array().items(jwkSchema) }).meta({ className: 'Jwks' }),
    },
  },
} satisfies Record<string, RouteDocs>;
