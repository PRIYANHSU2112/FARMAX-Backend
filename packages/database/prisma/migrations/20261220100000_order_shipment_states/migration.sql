-- D-57b (F1): latest known state per shipment, merged by shipment version, so a late or
-- out-of-order shipment.status_changed.v1 never moves fulfilmentStage back.
ALTER TABLE "orders" ADD COLUMN "shipmentStates" JSONB;
