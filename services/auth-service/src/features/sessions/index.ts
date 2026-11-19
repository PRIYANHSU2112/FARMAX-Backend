// Public API of the sessions feature. Other features import ONLY from here.
export { sessionsModule } from './sessions.module.js';
export type { SessionsService } from './sessions.service.js';
export type {
  CreatedSession,
  RotateResult,
  SessionRevokeReason,
  SessionView,
} from './sessions.types.js';
export { USER_TAG, sessionSchema } from './sessions.docs.js';
