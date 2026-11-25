import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { actorOf } from '../audit/index.js';
import type { AddWishlistInput, WishlistQuery } from './wishlist.types.js';

export interface ProductParams {
  productId: string;
}
type Req<T extends object = object> = FastifyRequest<T>;

const userIdOf = (request: FastifyRequest) => actorOf(request).userId;

/** HTTP only. 201 for a new item, 200 when it was already saved (idempotent add). */
export class WishlistController {
  private readonly wishlistService: Cradle['wishlistService'];

  constructor({ wishlistService }: Pick<Cradle, 'wishlistService'>) {
    this.wishlistService = wishlistService;
  }

  async list(request: Req<{ Querystring: WishlistQuery }>) {
    return paginated(await this.wishlistService.list(userIdOf(request), request.query));
  }

  async ids(request: FastifyRequest) {
    const { productIds, truncated } = await this.wishlistService.productIds(userIdOf(request));
    return { success: true, data: { productIds }, meta: { truncated } };
  }

  async add(request: Req<{ Body: AddWishlistInput }>, reply: FastifyReply) {
    const { created, item } = await this.wishlistService.add(
      userIdOf(request),
      request.body.productId,
    );
    return reply.code(created ? 201 : 200).send(ok(item));
  }

  async remove(request: Req<{ Params: ProductParams }>, reply: FastifyReply) {
    await this.wishlistService.remove(userIdOf(request), request.params.productId);
    return reply.code(204).send();
  }

  async clear(request: FastifyRequest, reply: FastifyReply) {
    await this.wishlistService.clear(userIdOf(request));
    return reply.code(204).send();
  }

  async adminList(request: Req<{ Params: { userId: string }; Querystring: WishlistQuery }>) {
    return paginated(await this.wishlistService.list(request.params.userId, request.query));
  }
}
