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
  NOTIFICATION_SERVICE_URL: string;
  CALL_SERVICE_URL: string;
  WALLET_SERVICE_URL: string;
  SUPPORT_SERVICE_URL: string;
  WAREHOUSE_SERVICE_URL: string;
  QUALITY_SERVICE_URL: string;
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
  NOTIFICATION_SERVICE_URL: url('http://localhost:3010'),
  CALL_SERVICE_URL: url('http://localhost:3011'),
  WALLET_SERVICE_URL: url('http://localhost:3012'),
  SUPPORT_SERVICE_URL: url('http://localhost:3013'),
  WAREHOUSE_SERVICE_URL: url('http://localhost:3014'),
  QUALITY_SERVICE_URL: url('http://localhost:3015'),
};
