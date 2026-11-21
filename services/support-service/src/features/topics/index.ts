// Public API of the topics feature.
export { topicsModule } from './topics.module.js';
export { HELP_TAG } from './topics.docs.js';
export type { TopicsService } from './topics.service.js';
export type { TopicView } from './topics.types.js';
export type { Priority, PriorityDecision, Team, TicketFacts } from './topics.rules.js';
export {
  type BusinessCalendar,
  type SlaPolicySnapshot,
  type SlaState,
  pauseClock,
  recomputeForPolicy,
  restartResolveClock,
  resumeClock,
  startClocks,
} from './topics.sla.js';
