import { NotFoundError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type {
  EventEnvelope,
  PaymentTopupCapturedV1,
  PaymentTopupExpiredV1,
  PaymentTopupFailedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import type { PaymentOutcome } from './topups.types.js';

const base = (paymentId: string, topupId: string): Omit<PaymentOutcome, 'state'> => ({
  paymentId,
  paymentNo: null,
  referenceId: topupId,
  capturedPaise: 0,
  method: null,
  bank: null,
  cardLast4: null,
  cardNetwork: null,
  vpaMasked: null,
  failureCode: null,
  failureReason: null,
  source: 'event',
});

/**
 * payment.topup_*.v1 → the top-up, inside the inbox transaction (a redelivered event is a no-op;
 * the ledger key topup:<id> is the second guard against a double credit).
 */
export const createTopupEventHandlers = ({
  topupsService,
  logger,
}: Pick<Cradle, 'topupsService' | 'logger'>) => {
  const apply = async (tx: Tx, topupId: string, o: PaymentOutcome) => {
    try {
      await topupsService.applyInTx(tx, topupId, o);
    } catch (err) {
      // An outcome for a top-up this wallet never created must not block the queue.
      if (!(err instanceof NotFoundError)) throw err;
      logger.error({ topupId, paymentId: o.paymentId }, 'payment outcome for an unknown top-up');
    }
  };

  const handlers: EventHandlerMap = {
    'payment.topup_captured.v1': (event: EventEnvelope, tx: Tx) => {
      const d = event.data as PaymentTopupCapturedV1;
      return apply(tx, d.topupId, {
        ...base(d.paymentId, d.topupId),
        state: 'CAPTURED',
        paymentNo: d.paymentNo,
        capturedPaise: d.amountPaise,
        method: d.method,
        bank: d.bank,
        cardLast4: d.cardLast4,
        cardNetwork: d.cardNetwork,
        vpaMasked: d.vpaMasked,
      });
    },
    'payment.topup_failed.v1': (event: EventEnvelope, tx: Tx) => {
      const d = event.data as PaymentTopupFailedV1;
      return apply(tx, d.topupId, {
        ...base(d.paymentId, d.topupId),
        state: 'FAILED',
        failureCode: d.errorCode,
        failureReason: d.errorReason,
      });
    },
    'payment.topup_expired.v1': (event: EventEnvelope, tx: Tx) => {
      const d = event.data as PaymentTopupExpiredV1;
      return apply(tx, d.topupId, { ...base(d.paymentId, d.topupId), state: 'EXPIRED' });
    },
  };
  return handlers;
};
