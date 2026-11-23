/**
 * Wire protocol of every FarmX WebSocket (one place; see `server.ts`).
 *
 * Client → server: `{ "id"?: string, "type": string, "data"?: unknown }`
 *   `id` (≤ 64 chars) is echoed back on the reply so the client can match it.
 * Server → client:
 *   reply  `{ "type": "ack",   "id": "<id>", "data": … }`
 *   error  `{ "type": "error", "id"?: "<id>", "error": { "code", "message" } }`
 *   push   `{ "type": "<event>", "room"?: "<room>", "data": … }`
 * Built-in client types: `ping` (→ ack `{ at }`). Everything else goes to the service's handlers.
 */
export interface ClientFrame {
  id?: string;
  type: string;
  data?: unknown;
}

export interface ServerFrame {
  type: string;
  id?: string;
  room?: string;
  data?: unknown;
  error?: { code: string; message: string };
}

/** Close codes (4000–4999 = application). Clients reconnect on 1001 / 1011 / 1013 only. */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011,
  TRY_AGAIN: 1013,
  UNAUTHORIZED: 4001,
  FORBIDDEN: 4003,
  RATE_LIMITED: 4008,
  TOO_MANY_CONNECTIONS: 4009,
} as const;

const TYPE = /^[a-z][a-z0-9._-]{0,39}$/;

/** Parses one text frame. Returns null for anything malformed (never throws). */
export function parseClientFrame(raw: string): ClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { id, type, data } = value as Record<string, unknown>;
  if (typeof type !== 'string' || !TYPE.test(type)) return null;
  if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > 64))
    return null;
  return { type, ...(id === undefined ? {} : { id }), ...(data === undefined ? {} : { data }) };
}
