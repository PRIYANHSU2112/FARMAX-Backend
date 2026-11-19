import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AuthController } from './auth.controller.js';
import { AuthRepository } from './auth.repository.js';
import { authRoutes } from './auth.routes.js';
import { AuthService } from './auth.service.js';
import { CredentialsService } from './credentials.service.js';
import { MfaService } from './mfa.service.js';
import { OtpService } from './otp.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    authRepository: AuthRepository;
    credentialsService: CredentialsService;
    otpService: OtpService;
    mfaService: MfaService;
    authService: AuthService;
    authController: AuthController;
  }
}

/** Authentication: customer OTP, admin password + TOTP, refresh, logout, passwords, MFA. */
export const authModule = defineModule({
  name: 'auth',
  register: (container) => {
    container.register({
      authRepository: asClass(AuthRepository).singleton(),
      credentialsService: asClass(CredentialsService).singleton(),
      otpService: asClass(OtpService).singleton(),
      mfaService: asClass(MfaService).singleton(),
      authService: asClass(AuthService).singleton(),
      authController: asClass(AuthController).singleton(),
    });
  },
  routes: authRoutes,
});
