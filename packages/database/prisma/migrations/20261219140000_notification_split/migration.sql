-- D-57b W3.14: buyer notice when an order is split / partly backordered (no extra cost; prepaid).
INSERT INTO "notification_templates" ("id", "key", "channel", "title", "body", "variables", "description") VALUES
  (gen_random_uuid(), 'shipment.split_planned', 'IN_APP', 'Order {{orderNo}} will arrive in {{legs}} deliveries',
   'To get your items to you sooner, order {{orderNo}} will arrive in {{legs}} separate deliveries. Any item not yet in stock follows as soon as it arrives, at no extra cost.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"legs","type":"string","maxLength":3}]',
   'Buyer: order split across warehouses / backordered');
