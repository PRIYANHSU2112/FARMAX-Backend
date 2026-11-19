import { Joi } from '@farmx/common/config';

/** Internal base URLs of the services the gateway proxies to. Add one per new service. */
export interface ServiceUrls {
  AUTH_SERVICE_URL: string;
  MEDIA_SERVICE_URL: string;
  FARM_SERVICE_URL: string;
  CATALOG_SERVICE_URL: string;
  PRODUCT_SERVICE_URL: string;
  USER_SERVICE_URL: string;
  ORDER_SERVICE_URL: string;
  INVENTORY_SERVICE_URL: string;
  PAYMENT_SERVICE_URL: string;
}

const url = (fallback: string) =>
  Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default(fallback);

export const serviceUrlsSchema = {
  AUTH_SERVICE_URL: url('http://localhost:3001'),
  MEDIA_SERVICE_URL: url('http://localhost:3002'),
  FARM_SERVICE_URL: url('http://localhost:3003'),
  CATALOG_SERVICE_URL: url('http://localhost:3004'),
  PRODUCT_SERVICE_URL: url('http://localhost:3005'),
  USER_SERVICE_URL: url('http://localhost:3006'),
  ORDER_SERVICE_URL: url('http://localhost:3007'),
  INVENTORY_SERVICE_URL: url('http://localhost:3008'),
  PAYMENT_SERVICE_URL: url('http://localhost:3009'),
};
