// Public API of the gate feature (D-62 W5 Gate & Weighbridge). Other features import ONLY from here.
export { gateAdminModule, gateInternalModule, gateModule, gateSetupModule } from './gate.module.js';
export type { GateEntriesService } from './gate.entries.service.js';
export type { GateJobs } from './gate.jobs.js';
export {
  ADMIN_GATE_TAG,
  GATE_AREA,
  GATE_ENTRY_AREA,
  GATE_SECURITY_AREA,
  GATE_WEIGH_AREA,
  GATE_YARD_AREA,
} from './gate.docs.js';
