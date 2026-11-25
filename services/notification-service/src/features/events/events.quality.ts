import type {
  EventEnvelope,
  QualityBatchRecalledV1,
  QualityCoaPublishedV1,
} from '@farmx/infra/events';

import type { NotificationDraft } from '../notifications/index.js';
import type { Rule } from './events.rules.js';

/**
 * quality-service events → customer notifications (D-60). Ids, batch / order numbers and the
 * product name only. A recall is SECURITY (mandatory: ignores opt-outs) and CRITICAL; one draft
 * per buyer, deduped per decision × user, so a redelivered event never notifies twice.
 * SMS / WhatsApp wait for DLT registration (Future): push + in-app for now.
 */
export const QUALITY_RULES: Readonly<Record<string, Rule>> = {
  'quality.batch_recalled.v1': {
    needsOrder: false,
    build: (event: EventEnvelope): NotificationDraft[] => {
      const d = event.data as QualityBatchRecalledV1;
      const seen = new Set<string>();
      return d.buyers.flatMap((b) => {
        if (seen.has(b.userId)) return [];
        seen.add(b.userId);
        return [
          {
            source: 'event',
            sourceEventId: event.id,
            dedupeKey: `quality.recall:${d.decisionId}:${b.userId}`,
            category: 'SECURITY',
            priority: 'CRITICAL',
            app: 'CUSTOMER',
            audience: { kind: 'users', userIds: [b.userId] },
            channels: ['PUSH'],
            templateKey: 'quality.batch_recalled',
            vars: { productName: d.productName, batchNo: d.batchNo, orderNo: b.orderNo },
            entityType: 'batch',
            entityId: d.batchId,
            data: {
              entityType: 'batch',
              entityId: d.batchId,
              cnNo: d.cnNos[0] ?? null,
              orderId: b.orderId,
            },
          },
        ];
      });
    },
  },
  'quality.coa_published.v1': {
    needsOrder: false,
    build: (event: EventEnvelope): NotificationDraft[] => {
      const d = event.data as QualityCoaPublishedV1;
      if (d.watcherUserIds.length === 0) return [];
      return [
        {
          source: 'event',
          sourceEventId: event.id,
          dedupeKey: `quality.coa_published:${d.coaId}`,
          category: 'ORDER',
          priority: d.verdict === 'FAIL' ? 'HIGH' : 'NORMAL',
          app: 'CUSTOMER',
          audience: { kind: 'users', userIds: [...new Set(d.watcherUserIds)] },
          channels: ['PUSH'],
          templateKey: 'quality.coa_published',
          vars: {
            productName: d.productName,
            batchNo: d.batchNo,
            verdict: d.verdict === 'PASS' ? 'passed' : 'failed',
          },
          entityType: 'batch',
          entityId: d.batchId,
          data: { entityType: 'batch', entityId: d.batchId, cnNo: d.cnNos[0] ?? null },
        },
      ];
    },
  },
};
