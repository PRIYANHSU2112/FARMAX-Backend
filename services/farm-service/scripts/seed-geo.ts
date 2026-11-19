/**
 * Seeds territories and pin code → node mapping for the launch belt (Godavari / Krishna, AP).
 * Idempotent (upserts). Run: `pnpm --filter @farmx/farm-service db:seed`.
 *
 * Node ids are FIXED placeholders until logistics-service owns nodes (proposed D-26); keep them
 * stable so farms seeded now keep valid references after the hand-over.
 */
import { createLogger } from '@farmx/common/logger';
import { closeDatabase, getDatabase } from '@farmx/database/client';

const NODES = {
  motherEluru: { id: '01937000-0000-7000-8000-00000000e101', name: 'Mother WH (Eluru)' },
  nuzvid: { id: '01937000-0000-7000-8000-00000000e102', name: 'Nuzvid C&F' },
  tanuku: { id: '01937000-0000-7000-8000-00000000e103', name: 'Tanuku C&F' },
  anaparthy: { id: '01937000-0000-7000-8000-00000000e104', name: 'Anaparthy C&F' },
} as const;

type Node = (typeof NODES)[keyof typeof NODES];

const TERRITORIES = [
  { code: 'WG', name: 'West Godavari', districtName: 'Eluru', stateCode: 'AP' },
  { code: 'EG', name: 'East Godavari', districtName: 'East Godavari', stateCode: 'AP' },
  { code: 'KR', name: 'Krishna', districtName: 'Krishna', stateCode: 'AP' },
] as const;

const PINS: {
  pin: string;
  territory: string;
  district: string;
  mandal: string;
  villages: string[];
  primary: Node;
  backup: Node;
  promise: string;
}[] = [
  {
    pin: '534432',
    territory: 'WG',
    district: 'Eluru',
    mandal: 'Denduluru',
    villages: ['Denduluru', 'Kovvali', 'Gopannapalem'],
    primary: NODES.motherEluru,
    backup: NODES.tanuku,
    promise: 'Next-day delivery',
  },
  {
    pin: '534001',
    territory: 'WG',
    district: 'Eluru',
    mandal: 'Eluru',
    villages: ['Eluru'],
    primary: NODES.motherEluru,
    backup: NODES.nuzvid,
    promise: 'Same-day delivery',
  },
  {
    pin: '534211',
    territory: 'WG',
    district: 'West Godavari',
    mandal: 'Tanuku',
    villages: ['Tanuku', 'Velpur'],
    primary: NODES.tanuku,
    backup: NODES.motherEluru,
    promise: 'Next-day delivery',
  },
  {
    pin: '534101',
    territory: 'WG',
    district: 'West Godavari',
    mandal: 'Tadepalligudem',
    villages: ['Tadepalligudem'],
    primary: NODES.tanuku,
    backup: NODES.motherEluru,
    promise: 'Next-day delivery',
  },
  {
    pin: '534201',
    territory: 'WG',
    district: 'West Godavari',
    mandal: 'Bhimavaram',
    villages: ['Bhimavaram'],
    primary: NODES.tanuku,
    backup: NODES.motherEluru,
    promise: 'Next-day delivery',
  },
  {
    pin: '533342',
    territory: 'EG',
    district: 'East Godavari',
    mandal: 'Anaparthy',
    villages: ['Anaparthy', 'Pulagurtha'],
    primary: NODES.anaparthy,
    backup: NODES.tanuku,
    promise: 'Next-day delivery',
  },
  {
    pin: '533101',
    territory: 'EG',
    district: 'East Godavari',
    mandal: 'Rajahmundry',
    villages: ['Rajahmundry'],
    primary: NODES.anaparthy,
    backup: NODES.tanuku,
    promise: 'Next-day delivery',
  },
  {
    pin: '521201',
    territory: 'KR',
    district: 'Eluru',
    mandal: 'Nuzvid',
    villages: ['Nuzvid'],
    primary: NODES.nuzvid,
    backup: NODES.motherEluru,
    promise: 'Next-day delivery',
  },
  {
    pin: '520001',
    territory: 'KR',
    district: 'NTR',
    mandal: 'Vijayawada',
    villages: ['Vijayawada'],
    primary: NODES.nuzvid,
    backup: NODES.motherEluru,
    promise: 'Next-day delivery',
  },
  {
    pin: '521301',
    territory: 'KR',
    district: 'Krishna',
    mandal: 'Gudivada',
    villages: ['Gudivada'],
    primary: NODES.nuzvid,
    backup: NODES.motherEluru,
    promise: '2-day delivery',
  },
];

const logger = createLogger({ service: 'farm-seed', level: 'info', appEnv: 'local', version: '0' });
const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error('DATABASE_URL is not set');
const db = getDatabase({ url, logger });

try {
  const ids = new Map<string, string>();
  for (const t of TERRITORIES) {
    const row = await db.territory.upsert({
      where: { code: t.code },
      create: t,
      update: { name: t.name, districtName: t.districtName },
    });
    ids.set(t.code, row.id);
  }
  for (const p of PINS) {
    const data = {
      territoryId: ids.get(p.territory) ?? '',
      territoryCode: p.territory,
      districtName: p.district,
      mandalName: p.mandal,
      villages: p.villages,
      primaryNodeId: p.primary.id,
      primaryNodeName: p.primary.name,
      backupNodeId: p.backup.id,
      backupNodeName: p.backup.name,
      deliveryPromise: p.promise,
      serviceable: true,
    };
    await db.pinCode.upsert({
      where: { pinCode: p.pin },
      create: { pinCode: p.pin, ...data },
      update: data,
    });
  }
  logger.info({ territories: TERRITORIES.length, pinCodes: PINS.length }, 'geo seed complete');
} finally {
  await closeDatabase();
}
