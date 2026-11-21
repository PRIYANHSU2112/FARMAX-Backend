// Public API of the tickets feature.
export { ticketsModule } from './tickets.module.js';
export { ADMIN_TICKETS_TAG, TICKETS_TAG } from './tickets.docs.js';
export { AGENTS_ROOM, ticketRoom } from './tickets.service.js';
export type { SendInput, TicketsService } from './tickets.service.js';
export type { TicketActor } from './tickets.types.js';
export { CLIENT_MESSAGE_ID, RECEIPTS } from './tickets.validation.js';
