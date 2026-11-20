import type { NotificationApp } from '../../domain.js';

export const PLATFORMS = ['ANDROID', 'IOS', 'WEB'] as const;
export type DevicePlatform = (typeof PLATFORMS)[number];

/** Active tokens per user; registering an 11th revokes the least recently seen. */
export const MAX_DEVICES_PER_USER = 10;

export interface RegisterDeviceInput {
  token: string;
  platform: DevicePlatform;
  app?: NotificationApp;
  deviceId?: string;
}

/** Never includes the token itself. */
export interface DeviceView {
  id: string;
  app: NotificationApp;
  platform: DevicePlatform;
  deviceId: string | null;
  lastSeenAt: Date;
  createdAt: Date;
}
