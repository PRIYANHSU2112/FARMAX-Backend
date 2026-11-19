import { AppError, ErrorCode, NotFoundError, type ValidationIssue } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import { orderKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import {
  type BuyerContext,
  type PricingConfig,
  type PricingLine,
  type WaterfallInput,
  evaluateOffers,
  priceCart,
  toBasisPoints,
  toPaise,
} from '../pricing/index.js';
import { type FarmFacts, type VariantFacts, isSellable } from '../projections/index.js';
import type { OffersInput, PreviewInput } from './offers.types.js';
import { offersView, previewView } from './offers.views.js';

type Deps = Pick<
  Cradle,
  'projectionsService' | 'promotionsService' | 'config' | 'redis' | 'logger'
>;

/** Same normalisation as stored codes (trim + UPPERCASE); empty → no coupon. */
const normalizeCode = (code: string | undefined): string | null => {
  const c = code?.trim().toUpperCase() ?? '';
  return c === '' ? null : c;
};

/**
 * "Offers for this order" and "Billing details & tax invoice". Prices are always re-read from the
 * projections on the server (client amounts are never trusted). Both answers are ADVISORY: limits
 * are re-checked inside the checkout transaction (Step 2) [R7].
 */
export class OffersService {
  constructor(private readonly deps: Deps) {}

  /** Public coupons page, Redis-cached for 60 s per category filter (fail-open when Redis is down). */
  async publicOffers(categoryId?: string) {
    const { redis, logger, promotionsService } = this.deps;
    const key = orderKeys.publicOffers(categoryId ?? 'all');
    try {
      const hit = await redis.get(key);
      if (hit !== null)
        return JSON.parse(hit) as Awaited<ReturnType<typeof promotionsService.publicList>>;
    } catch (err) {
      logger.warn({ err }, 'public offers cache unavailable');
    }
    const list = await promotionsService.publicList(new Date(), categoryId);
    await redis.set(key, JSON.stringify(list), 'EX', 60).catch(() => undefined);
    return list;
  }

  async offers(user: AuthUser, input: OffersInput) {
    const { pricing } = await this.load(user, input);
    return offersView(evaluateOffers(pricing));
  }

  /**
   * Cart screen: offers + full bill for the cart lines in one pass. The cart already read the
   * variants (passed in, no second read) and sends only sellable lines.
   */
  async forCart(user: AuthUser, input: OffersInput, variants: readonly VariantFacts[]) {
    const { pricing, farm } = await this.load(user, input, variants);
    const result = evaluateOffers(pricing);
    return {
      offers: offersView(result),
      bill: previewView(result.pricing, farm, false, this.deps.config.SELLER_STATE_CODE),
    };
  }

  async preview(user: AuthUser, input: PreviewInput) {
    const { pricing, farm } = await this.load(user, input);
    return previewView(
      priceCart(pricing),
      farm,
      input.billToGst,
      this.deps.config.SELLER_STATE_CODE,
    );
  }

  /** Checkout: the same server-side pricing as the preview, returned raw (result + facts). */
  async priceForCheckout(user: AuthUser, input: PreviewInput) {
    const { pricing, farm, variants } = await this.load(user, input);
    return { result: priceCart(pricing), farm, variants };
  }

  private async load(
    user: AuthUser,
    input: OffersInput,
    preloaded?: readonly VariantFacts[],
  ): Promise<{ pricing: WaterfallInput; farm: FarmFacts; variants: readonly VariantFacts[] }> {
    const { projectionsService, promotionsService, config } = this.deps;
    const now = new Date();
    // [R5] Own, ACTIVE farm only; anything else is indistinguishable from "does not exist".
    const farm = await projectionsService.farm(input.farmId);
    if (farm?.ownerUserId !== user.id || farm.status !== 'ACTIVE') throw new NotFoundError('Farm');

    const [variants, promotions, farmOrderCount] = await Promise.all([
      preloaded ?? projectionsService.variants(input.lines.map((l) => l.variantId)),
      promotionsService.activeForPricing(now),
      promotionsService.farmOrderCount(farm.farmId),
    ]);
    const byId = new Map(variants.map((v) => [v.variantId, v]));
    const issues: ValidationIssue[] = [];
    const lines: PricingLine[] = [];
    input.lines.forEach((l, i) => {
      const v = byId.get(l.variantId);
      if (!isSellable(v)) {
        issues.push({
          path: `body.lines[${String(i)}].variantId`,
          message: 'is not available for sale (inactive, or price / HSN / GST rate missing)',
        });
        return;
      }
      lines.push({
        variantId: v.variantId,
        productId: v.productId,
        sku: v.sku ?? '',
        name: v.name ?? '',
        categoryId: v.categoryId,
        categoryPath: v.categoryPath,
        brandId: v.brandId,
        qty: l.qty,
        // Phase 0: tier and member prices come with pricing-service; the list price for now.
        unitPrice: toPaise(v.sellingPrice),
        priceSource: 'LIST',
        hsnCode: v.hsnCode,
        gstRate: toBasisPoints(v.gstRate),
        temperatureClass: v.temperatureClass,
      });
    });
    if (issues.length > 0)
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Some items are not available for sale', 422, {
        details: { reason: 'VARIANT_NOT_SELLABLE', issues },
      });

    const usage = await promotionsService.usage(
      promotions.map((p) => p.id),
      farm.farmId,
      user.id,
    );
    const buyer: BuyerContext = {
      farmId: farm.farmId,
      userId: user.id,
      gstin: farm.gstin,
      farmCategory: farm.category,
      productionTypes: farm.productionTypes,
      stateCode: farm.stateCode,
      territoryCode: farm.territoryCode,
      pinCode: farm.pinCode,
      farmOrderCount,
      // FarmX membership does not exist yet: member-only offers are shown as not eligible.
      isMember: false,
      paymentMethod: input.paymentMethod ?? null,
      bankCode: input.bankCode ?? null,
      cardBin: input.cardBin ?? null,
      usage,
      now,
    };
    const pricingConfig: PricingConfig = {
      sellerStateCode: config.SELLER_STATE_CODE,
      coldChainFreight: toPaise(config.FREIGHT_COLD_CHAIN),
      standardFreight: toPaise(config.FREIGHT_STANDARD),
      freightGstRate: toBasisPoints(config.FREIGHT_GST_RATE),
      freightSacCode: config.FREIGHT_SAC_CODE,
    };
    return {
      farm,
      variants,
      pricing: {
        lines,
        promotions,
        buyer,
        config: pricingConfig,
        couponCode: normalizeCode(input.couponCode),
        applyBundleIds: input.applyBundleIds ?? [],
      },
    };
  }
}
