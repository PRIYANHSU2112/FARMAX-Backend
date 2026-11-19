import { UnauthorizedError } from '@farmx/common/errors';
import { ok } from '@farmx/common/response';
import type { AuthUser } from '@farmx/common/types';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { DevicePlatform, RequestMeta } from './auth.types.js';

interface DeviceBody {
  deviceId?: string;
  deviceName?: string;
  platform?: DevicePlatform;
}

/** IP (trusted proxy aware), user agent and optional device info for sessions and auth events. */
const metaOf = (request: FastifyRequest<{ Body?: unknown }>): RequestMeta => {
  const body = (request.body ?? {}) as DeviceBody;
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: userAgent === undefined ? null : userAgent.slice(0, 512),
    ...(body.deviceId === undefined ? {} : { deviceId: body.deviceId }),
    ...(body.deviceName === undefined ? {} : { deviceName: body.deviceName }),
    ...(body.platform === undefined ? {} : { platform: body.platform }),
  };
};

const callerOf = (request: FastifyRequest): AuthUser => {
  if (request.user === null) throw new UnauthorizedError();
  return request.user;
};

/** HTTP only: read the request, call AuthService, wrap the response. */
export class AuthController {
  private readonly authService: Cradle['authService'];

  constructor({ authService }: Pick<Cradle, 'authService'>) {
    this.authService = authService;
  }

  async otpSend(request: FastifyRequest<{ Body: { phone: string } }>) {
    return ok(await this.authService.sendLoginOtp(request.body.phone, metaOf(request)));
  }

  async otpVerify(request: FastifyRequest<{ Body: { phone: string; code: string } & DeviceBody }>) {
    return ok(
      await this.authService.verifyLoginOtp(request.body.phone, request.body.code, metaOf(request)),
    );
  }

  async adminLogin(
    request: FastifyRequest<{ Body: { identifier: string; password: string } & DeviceBody }>,
  ) {
    return ok(
      await this.authService.adminLogin(
        request.body.identifier,
        request.body.password,
        metaOf(request),
      ),
    );
  }

  async mfaVerify(
    request: FastifyRequest<{
      Body: { challengeId: string; code?: string; recoveryCode?: string };
    }>,
  ) {
    const { challengeId, code, recoveryCode } = request.body;
    const input = recoveryCode === undefined ? { code: code ?? '' } : { recoveryCode };
    return ok(await this.authService.verifyMfa(challengeId, input, metaOf(request)));
  }

  async refresh(request: FastifyRequest<{ Body: { refreshToken: string } }>) {
    return ok(await this.authService.refresh(request.body.refreshToken, metaOf(request)));
  }

  async logout(request: FastifyRequest, reply: FastifyReply) {
    await this.authService.logout(callerOf(request), metaOf(request));
    return reply.code(204).send();
  }

  async logoutAll(request: FastifyRequest) {
    return ok(await this.authService.logoutAll(callerOf(request), metaOf(request)));
  }

  async forgotPassword(request: FastifyRequest<{ Body: { identifier: string } }>) {
    return ok(await this.authService.forgotPassword(request.body.identifier, metaOf(request)));
  }

  async resetPassword(
    request: FastifyRequest<{ Body: { identifier: string; code: string; newPassword: string } }>,
    reply: FastifyReply,
  ) {
    const { identifier, code, newPassword } = request.body;
    await this.authService.resetPassword(identifier, code, newPassword, metaOf(request));
    return reply.code(204).send();
  }

  async changePassword(
    request: FastifyRequest<{ Body: { currentPassword: string; newPassword: string } }>,
    reply: FastifyReply,
  ) {
    const { currentPassword, newPassword } = request.body;
    await this.authService.changePassword(
      callerOf(request),
      currentPassword,
      newPassword,
      metaOf(request),
    );
    return reply.code(204).send();
  }

  async totpEnroll(request: FastifyRequest) {
    return ok(await this.authService.startTotpEnrollment(callerOf(request)));
  }

  async totpConfirm(request: FastifyRequest<{ Body: { code: string } }>) {
    return ok(
      await this.authService.confirmTotpEnrollment(
        callerOf(request),
        request.body.code,
        metaOf(request),
      ),
    );
  }

  async totpDisable(request: FastifyRequest<{ Body: { code: string } }>, reply: FastifyReply) {
    await this.authService.disableTotp(callerOf(request), request.body.code, metaOf(request));
    return reply.code(204).send();
  }
}
