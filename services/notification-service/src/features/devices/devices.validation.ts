import Joi from 'joi';

import { APP, idParams } from '../../middleware/http.js';
import { PLATFORMS } from './devices.types.js';

export const registerDeviceSchema = {
  body: Joi.object({
    token: Joi.string()
      .min(20)
      .max(512)
      .pattern(/^[A-Za-z0-9_:\-.]+$/)
      .required()
      .description('FCM registration token from the Firebase SDK on the device'),
    platform: Joi.string()
      .valid(...PLATFORMS)
      .required(),
    app: APP,
    deviceId: Joi.string()
      .max(100)
      .pattern(/^[A-Za-z0-9_\-.:]+$/)
      .description("Stable app-install id (optional; for the user's device list)"),
  }),
};

export const deviceIdSchema = idParams;
