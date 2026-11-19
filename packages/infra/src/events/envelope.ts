/**
 * Every event on the RabbitMQ `events` exchange is wrapped in this envelope.
 * The routing key is `type` (`<aggregate>.<event>.v<N>`). See docs/event-contracts.md.
 */
export interface EventEnvelope<TType extends string = string, TData = unknown> {
  /** UUID v7; also the outbox row id and the consumer de-duplication key (inbox). */
  id: string;
  /** Routing key, e.g. `user.registered.v1`. */
  type: TType;
  /** Contract version, the `N` in `.vN`. A breaking change is a new type, never an edit. */
  version: number;
  /** ISO-8601 time the fact happened (the producer's commit time). */
  occurredAt: string;
  /** Producing service, e.g. `auth-service`. */
  source: string;
  /** Request id of the originating HTTP call, carried through every hop. */
  correlationId: string;
  /** Id of the event that caused this one, if any. */
  causationId?: string;
  data: TData;
}

/** Routing keys must be `<aggregate>.<event>.v<N>` in lower snake_case. */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z_]*\.[a-z][a-z_]*\.v[1-9]\d*$/;
