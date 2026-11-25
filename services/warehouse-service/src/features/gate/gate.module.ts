import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { GateAdminService } from './gate.admin.service.js';
import { gateAdminRoutes, gateInternalRoutes } from './gate.admin.routes.js';
import { GateAppointmentsService } from './gate.appointments.service.js';
import { GateAsnService } from './gate.asn.service.js';
import { GateDashboardService } from './gate.dashboard.service.js';
import { GateEntriesService } from './gate.entries.service.js';
import { GateJobs } from './gate.jobs.js';
import { GatePassesService } from './gate.passes.service.js';
import { GateRegistersRepository } from './gate.registers.repository.js';
import { GateRepository } from './gate.repository.js';
import { gateRoutes } from './gate.routes.js';
import { GateSecurityService } from './gate.security.service.js';
import { GateShipmentsService } from './gate.shipments.service.js';
import { GateSupport } from './gate.support.js';
import { GateWeighbridgeService } from './gate.weighbridge.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    gateRepository: GateRepository;
    gateRegistersRepository: GateRegistersRepository;
    gateSupport: GateSupport;
    gateShipments: GateShipmentsService;
    gateEntries: GateEntriesService;
    gateWeighbridge: GateWeighbridgeService;
    gatePasses: GatePassesService;
    gateDashboard: GateDashboardService;
    gateAppointments: GateAppointmentsService;
    gateAsn: GateAsnService;
    gateSecurity: GateSecurityService;
    gateAdmin: GateAdminService;
    gateJobs: GateJobs;
  }
}

/** D-62 W5 Gate & Weighbridge: warehouse panel `/wms/gate/*` (scoped to the caller's warehouses). */
export const gateModule = defineModule({
  name: 'gate',
  prefix: '/wms',
  register: (container) => {
    container.register({
      gateRepository: asClass(GateRepository).singleton(),
      gateRegistersRepository: asClass(GateRegistersRepository).singleton(),
      gateSupport: asClass(GateSupport).singleton(),
      gateShipments: asClass(GateShipmentsService).singleton(),
      gateEntries: asClass(GateEntriesService).singleton(),
      gateWeighbridge: asClass(GateWeighbridgeService).singleton(),
      gatePasses: asClass(GatePassesService).singleton(),
      gateDashboard: asClass(GateDashboardService).singleton(),
      gateAppointments: asClass(GateAppointmentsService).singleton(),
      gateAsn: asClass(GateAsnService).singleton(),
      gateSecurity: asClass(GateSecurityService).singleton(),
      gateAdmin: asClass(GateAdminService).singleton(),
      gateJobs: asClass(GateJobs).singleton(),
    });
  },
  routes: gateRoutes('panel'),
});

/** Same handlers for the admin panel (`/admin/wms/gate/*`, GLOBAL grants, every warehouse). */
export const gateAdminModule = defineModule({
  name: 'gate-admin',
  prefix: '/admin/wms',
  routes: gateRoutes('admin'),
});

/** Warehouse setup: weighbridge scales + gate settings (`/admin/warehouses/:id/...`). */
export const gateSetupModule = defineModule({
  name: 'gate-setup',
  prefix: '/admin/warehouses',
  routes: gateAdminRoutes,
});

/** Vendor portal / EDI ASN intake (`/internal/wms/gate/*`, service token). */
export const gateInternalModule = defineModule({
  name: 'gate-internal',
  prefix: '/internal/wms',
  routes: gateInternalRoutes,
});
