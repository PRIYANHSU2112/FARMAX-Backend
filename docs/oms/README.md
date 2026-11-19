# Order management + payments (OMS)

The approved design (2026-11-20) for admin-confirmed orders, the new payment-service and the
inventory reservation changes they need. Decisions D-33 … D-45 are in [`../decisions.md`](../decisions.md).

| Doc                                                           | Contents                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [01-hld](01-hld.md)                                           | Workflow, service ownership, checkout fast path, async flow                                                    |
| [02-screen-map-and-conflicts](02-screen-map-and-conflicts.md) | Figma screens → backend; conflicts and gaps                                                                    |
| [03-state-machines](03-state-machines.md)                     | Order, payment, stock and refund statuses; refund lifecycles; recovery playbook (R1–R9); shipment and OTP (F1) |
| [04-database](04-database.md)                                 | Tables for order-service, payment-service and the inventory changes                                            |
| [05-api](05-api.md)                                           | Customer, admin and internal APIs; permissions                                                                 |
| [06-events](06-events.md)                                     | Event contracts and background jobs                                                                            |
| [07-security](07-security.md)                                 | Security controls                                                                                              |
| [08-phases](08-phases.md)                                     | Phases, risks, verification                                                                                    |
