// The ONE WebSocket layer of FarmX (support chat today; any service can mount it).
// A service supplies: a connect-token issuer route, frame handlers and a revalidate hook.
// Everything else — upgrade, origin, limits, heartbeat, rooms, cross-replica fan-out — is here.
export * from './protocol.js';
export * from './tokens.js';
export * from './connection.js';
export * from './hub.js';
export * from './server.js';
