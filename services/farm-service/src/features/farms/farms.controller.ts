import { ValidationError } from '@farmx/common/errors';
import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { idempotent } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import type {
  AdminAction,
  AdminFarmListQuery,
  AdminUpdateInput,
  DetailsInput,
  FarmCategory,
  FarmListQuery,
  LocationInput,
  OwnerPrefsInput,
  QuickSignupInput,
  UpdateActiveFarmInput,
} from './farms.types.js';
import { parseIfMatch } from './farms.validation.js';

export interface IdParams {
  id: string;
}
type Req<T extends object = object> = FastifyRequest<T>;

const userId = (request: FastifyRequest): string => actorOf(request).userId;
const ifMatch = (request: FastifyRequest) => parseIfMatch(request.headers['if-match']);

/** HTTP only: read the request, call the service, wrap the response (+ ETag on farm views). */
export class FarmsController {
  private readonly farmsService: Cradle['farmsService'];

  constructor({ farmsService }: Pick<Cradle, 'farmsService'>) {
    this.farmsService = farmsService;
  }

  private withEtag<T extends { version: number }>(reply: FastifyReply, view: T) {
    void reply.header('etag', `"${String(view.version)}"`);
    return ok(view);
  }

  categories(_request: FastifyRequest, reply: FastifyReply) {
    void reply.header('cache-control', 'public, max-age=3600');
    return ok(this.farmsService.categories());
  }

  async list(request: Req<{ Querystring: FarmListQuery }>) {
    return paginated(await this.farmsService.listOwned(userId(request), request.query));
  }

  async get(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return this.withEtag(
      reply,
      await this.farmsService.getOwned(userId(request), request.params.id),
    );
  }

  async createDraft(request: Req<{ Body: { category: FarmCategory } }>, reply: FastifyReply) {
    const result = await idempotent(request, async () => ({
      status: 201,
      body: ok(await this.farmsService.createDraft(actorOf(request), request.body.category, null)),
    }));
    return reply.code(result.status).send(result.body);
  }

  async quick(request: Req<{ Body: QuickSignupInput }>, reply: FastifyReply) {
    const result = await idempotent(request, async () => ({
      status: 201,
      body: ok(await this.farmsService.quickSignup(actorOf(request), request.body, null)),
    }));
    return reply.code(result.status).send(result.body);
  }

  async details(request: Req<{ Params: IdParams; Body: DetailsInput }>, reply: FastifyReply) {
    return this.withEtag(
      reply,
      await this.farmsService.updateDetails(
        actorOf(request),
        request.params.id,
        ifMatch(request),
        request.body,
      ),
    );
  }

  async location(request: Req<{ Params: IdParams; Body: LocationInput }>, reply: FastifyReply) {
    return this.withEtag(
      reply,
      await this.farmsService.setLocation(
        actorOf(request),
        request.params.id,
        ifMatch(request),
        request.body,
      ),
    );
  }

  async owner(request: Req<{ Params: IdParams; Body: OwnerPrefsInput }>, reply: FastifyReply) {
    return this.withEtag(
      reply,
      await this.farmsService.updateOwnerPrefs(actorOf(request), request.params.id, request.body),
    );
  }

  async deferKyc(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return this.withEtag(
      reply,
      await this.farmsService.deferKyc(actorOf(request), request.params.id),
    );
  }

  async discard(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    await this.farmsService.discardDraft(actorOf(request), request.params.id);
    return reply.code(204).send();
  }

  async submit(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    const result = await idempotent(request, async () => ({
      status: 200,
      body: ok(
        await this.farmsService.submit(actorOf(request), request.params.id, ifMatch(request)),
      ),
    }));
    return reply.code(result.status).send(result.body);
  }

  async pass(request: Req<{ Params: IdParams }>) {
    return ok(await this.farmsService.pass(userId(request), request.params.id));
  }

  async updateActive(
    request: Req<{ Params: IdParams; Body: UpdateActiveFarmInput }>,
    reply: FastifyReply,
  ) {
    return this.withEtag(
      reply,
      await this.farmsService.updateActive(
        actorOf(request),
        request.params.id,
        ifMatch(request),
        request.body,
      ),
    );
  }

  async verifyPass(request: Req<{ Params: { farmCode: string }; Querystring: { sig: string } }>) {
    return ok(await this.farmsService.verifyPass(request.params.farmCode, request.query.sig));
  }

  // ── Admin ──

  async adminList(request: Req<{ Querystring: AdminFarmListQuery }>) {
    return paginated(await this.farmsService.adminList(request.query));
  }

  async adminStats() {
    return ok(await this.farmsService.stats());
  }

  async adminGet(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return this.withEtag(reply, await this.farmsService.adminGet(request.params.id));
  }

  async adminHistory(
    request: Req<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>,
  ) {
    return paginated(await this.farmsService.adminHistory(request.params.id, request.query));
  }

  async adminUpdate(
    request: Req<{ Params: IdParams; Body: AdminUpdateInput }>,
    reply: FastifyReply,
  ) {
    return this.withEtag(
      reply,
      await this.farmsService.adminUpdate(
        actorOf(request),
        request.params.id,
        ifMatch(request),
        request.body,
      ),
    );
  }

  async adminAction(
    action: AdminAction,
    request: Req<{
      Params: IdParams;
      Body: { reason: string; issues?: { docType: string; code: string; message: string }[] };
    }>,
    reply: FastifyReply,
  ) {
    if (action === 'request-changes' && request.body.issues === undefined) {
      throw new ValidationError([
        { path: 'issues', message: 'list at least one issue for the owner to fix' },
      ]);
    }
    return this.withEtag(
      reply,
      await this.farmsService.adminAction(
        actorOf(request),
        request.params.id,
        action,
        request.body,
        ifMatch(request),
      ),
    );
  }

  // ── Internal ──

  async internalGet(request: Req<{ Params: IdParams }>) {
    return ok(await this.farmsService.internalGet(request.params.id));
  }

  async internalBatch(request: Req<{ Body: { ids: string[] } }>) {
    return ok(await this.farmsService.internalBatch(request.body.ids));
  }

  async internalByCode(request: Req<{ Params: { farmCode: string } }>) {
    return ok(await this.farmsService.findByCode(request.params.farmCode));
  }
}
