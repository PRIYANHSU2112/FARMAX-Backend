import type { RouteDocs } from '@farmx/common/server';

import { AUTH_STAFF, IDS, tagOf } from '../../docs/shared.js';
import type { Audience } from '../../middleware/guards.js';

export const AUDIT_AREA = 'Audit';

export const auditDocs = (aud: Audience): { list: RouteDocs } => ({
  list: {
    tag: tagOf(aud, AUDIT_AREA),
    summary: 'Audit trail (who entered results, who approved, who released)',
    description:
      'Append-only quality audit, newest first. Every sample step, COA upload / result entry / review, spec and lab change, decision and warehouse task is recorded with the actor, before / after values, reason, request id and IP. W16.03 / W16.08 "Laboratory audit trail available".',
    auth: AUTH_STAFF(aud),
    permission: 'quality.view',
    success: {
      status: 200,
      description: 'Audit rows',
      paginated: true,
      example: {
        success: true,
        data: [
          {
            id: IDS.decision,
            actorUserId: IDS.user,
            actorType: 'STAFF',
            action: 'coa.approved',
            targetType: 'coa',
            targetId: IDS.coa,
            warehouseId: null,
            before: { status: 'RESULTS_ENTERED' },
            after: { status: 'APPROVED', verdict: 'PASS' },
            reason: 'All parameters within limits',
            requestId: 'req-1',
            ip: '10.0.0.1',
            at: '2026-11-25T10:30:00.000Z',
          },
        ],
        meta: { nextCursor: null, limit: 20 },
      },
    },
  },
});
