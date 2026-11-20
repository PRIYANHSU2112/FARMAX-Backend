import { NotFoundError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import type { NotificationApp } from '../../domain.js';
import type { DeviceView, RegisterDeviceInput } from './devices.types.js';

type Deps = Pick<Cradle, 'devicesRepository'>;

/** FCM registration tokens of the signed-in user. */
export class DevicesService {
  constructor(private readonly deps: Deps) {}

  register(userId: string, app: NotificationApp, input: RegisterDeviceInput): Promise<DeviceView> {
    return this.deps.devicesRepository.register({
      id: uuidv7(),
      userId,
      app,
      platform: input.platform,
      token: input.token,
      deviceId: input.deviceId ?? null,
    });
  }

  /** Push targets for a delivery (worker side; tokens never leave this service's callers). */
  pushTargets(userId: string, app: NotificationApp): Promise<{ id: string; token: string }[]> {
    return this.deps.devicesRepository.activeTokens(userId, app);
  }

  revokeDead(ids: readonly string[]): Promise<void> {
    return this.deps.devicesRepository.revokeMany(ids);
  }

  list(userId: string): Promise<DeviceView[]> {
    return this.deps.devicesRepository.listActive(userId);
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!(await this.deps.devicesRepository.revoke(userId, id)))
      throw new NotFoundError('Device not found');
  }
}
