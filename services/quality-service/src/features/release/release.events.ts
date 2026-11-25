import type {
  WarehouseQualityTasksPlannedV1,
  WarehouseQualityTaskUpdatedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/** warehouse-service task progress → decision mirror (APPLYING / APPLIED / PARTIAL / FAILED). */
export const createReleaseEventHandlers = ({
  releaseService,
}: Pick<Cradle, 'releaseService'>): EventHandlerMap => ({
  'warehouse.quality_tasks_planned.v1': (e, tx) =>
    releaseService.onTasksPlanned(tx, e.data as WarehouseQualityTasksPlannedV1),
  'warehouse.quality_task_updated.v1': (e, tx) =>
    releaseService.onTaskUpdated(tx, e.data as WarehouseQualityTaskUpdatedV1),
});
