/**
 * Seeds Help & Support defaults. Idempotent (upserts / find-or-create); never overwrites rows an
 * admin already edited except SLA policies and topics' labels on first creation.
 * Run: `pnpm --filter @farmx/support-service db:seed`.
 */
import { createLogger } from '@farmx/common/logger';
import { type Prisma, closeDatabase, getDatabase } from '@farmx/database/client';

type App = 'CUSTOMER' | 'VENDOR' | 'LOGISTICS' | 'WAREHOUSE';
type Priority = 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW';
type Team = 'SUPPORT' | 'VET' | 'LOGISTICS' | 'FINANCE' | 'QUALITY' | 'WAREHOUSE';

const SYSTEM_USER = '00000000-0000-7000-8000-000000000000';
const APPS: App[] = ['CUSTOMER', 'VENDOR', 'LOGISTICS', 'WAREHOUSE'];

interface TopicSeed {
  code: string;
  label: string;
  description?: string;
  icon?: string;
  defaultPriority?: Priority;
  team?: Team;
  requiresOrder?: boolean;
  isCommonIssue?: boolean;
}

const TOPICS: Record<App, TopicSeed[]> = {
  CUSTOMER: [
    { code: 'DELIVERY_RETURNS', label: 'Delivery & returns', description: 'Late, damaged or warm deliveries; returns', icon: 'truck', requiresOrder: true, isCommonIssue: true, team: 'LOGISTICS' },
    { code: 'PAYMENT', label: 'Payment', description: 'Track your payments and refunds', icon: 'wallet', isCommonIssue: true, team: 'FINANCE' },
    { code: 'PRODUCT_QUALITY', label: 'Product quality', description: 'Expiry, batch or quality concerns', icon: 'shield', requiresOrder: true, team: 'QUALITY' },
    { code: 'PRESCRIPTION', label: 'Prescription', description: 'Prescription or vet approval', icon: 'file-medical', team: 'VET' },
    { code: 'ACCOUNT', label: 'Account & membership', icon: 'user', defaultPriority: 'LOW' },
    { code: 'OTHER', label: 'Something else', icon: 'help', defaultPriority: 'LOW' },
  ],
  VENDOR: [
    { code: 'SETTLEMENT', label: 'Payouts & settlement', description: 'Same-day settlement questions', icon: 'wallet', isCommonIssue: true, team: 'FINANCE' },
    { code: 'ORDERS', label: 'Orders & consignment', icon: 'box', isCommonIssue: true },
    { code: 'LISTING', label: 'Product listing', icon: 'tag', defaultPriority: 'LOW' },
    { code: 'KYC', label: 'KYC & documents', icon: 'id-card' },
    { code: 'OTHER', label: 'Something else', icon: 'help', defaultPriority: 'LOW' },
  ],
  LOGISTICS: [
    { code: 'DELIVERY_ISSUE', label: 'Delivery problem', description: 'Address, OTP or farm access issues', icon: 'truck', defaultPriority: 'HIGH', isCommonIssue: true, team: 'LOGISTICS' },
    { code: 'COLD_CHAIN', label: 'Cold-chain alarm', description: 'Logger or cooler out of 2–8 °C', icon: 'thermometer', defaultPriority: 'URGENT', team: 'QUALITY' },
    { code: 'EARNINGS', label: 'Earnings & payouts', icon: 'wallet', isCommonIssue: true, team: 'FINANCE' },
    { code: 'APP_ISSUE', label: 'App problem', icon: 'phone', defaultPriority: 'LOW' },
    { code: 'OTHER', label: 'Something else', icon: 'help', defaultPriority: 'LOW' },
  ],
  WAREHOUSE: [
    { code: 'INVENTORY', label: 'Stock & inventory', icon: 'boxes', isCommonIssue: true, team: 'WAREHOUSE' },
    { code: 'EQUIPMENT', label: 'Cold room / equipment', icon: 'thermometer', defaultPriority: 'HIGH', team: 'WAREHOUSE' },
    { code: 'SYSTEM', label: 'Handheld / system', icon: 'scan', isCommonIssue: true },
    { code: 'OTHER', label: 'Something else', icon: 'help', defaultPriority: 'LOW' },
  ],
};

const RULES: {
  name: string;
  app: App | null;
  topicCode: string | null;
  conditions: Prisma.InputJsonValue;
  priority: Priority;
  reasonLabel: string;
  team: Team | null;
  sortOrder: number;
}[] = [
  { name: 'Mortality reported', app: null, topicCode: null, conditions: { keywords: ['dead', 'mortality', 'dying', 'died'] }, priority: 'URGENT', reasonLabel: 'mortality', team: 'VET', sortOrder: 10 },
  { name: 'Cold-chain order', app: 'CUSTOMER', topicCode: null, conditions: { temperatureClasses: ['CC_REF', 'CC_FRZ'] }, priority: 'HIGH', reasonLabel: 'cold chain', team: null, sortOrder: 20 },
  { name: 'Warm vaccines (text)', app: null, topicCode: null, conditions: { keywords: ['warm', 'melted', 'not cold', 'ice pack'] }, priority: 'HIGH', reasonLabel: 'cold chain', team: null, sortOrder: 30 },
  { name: 'High-value order', app: 'CUSTOMER', topicCode: null, conditions: { minOrderAmount: 100000 }, priority: 'HIGH', reasonLabel: 'high value', team: null, sortOrder: 40 },
];

const SLA: Record<Priority, { firstResponseMins: number; resolveMins: number; businessHoursOnly: boolean }> = {
  URGENT: { firstResponseMins: 15, resolveMins: 240, businessHoursOnly: false },
  HIGH: { firstResponseMins: 60, resolveMins: 480, businessHoursOnly: false },
  MEDIUM: { firstResponseMins: 240, resolveMins: 1440, businessHoursOnly: true },
  LOW: { firstResponseMins: 480, resolveMins: 2880, businessHoursOnly: true },
};

const FAQS: Record<App, { code: string; title: string; items: { q: string; a: string; topics?: string[] }[] }[]> = {
  CUSTOMER: [
    {
      code: 'MEMBERSHIP',
      title: 'Membership',
      items: [
        { q: 'Can I cancel my membership anytime?', a: 'Yes. Cancel anytime from Profile → Membership. No cancellation fee. Benefits continue till the end of your billing cycle.', topics: ['ACCOUNT', 'PAYMENT'] },
        { q: 'Is there a lock-in period?', a: 'No. Membership is month to month.', topics: ['ACCOUNT'] },
        { q: 'Do my benefits reset every month?', a: 'Yes. Monthly benefits reset on your billing date; unused benefits do not carry over.', topics: ['ACCOUNT'] },
        { q: 'How are reward points calculated?', a: 'You earn points on every delivered order. Points mature after the return window and can be converted in Wallet.', topics: ['PAYMENT'] },
      ],
    },
    {
      code: 'DELIVERY',
      title: 'Delivery & cold chain',
      items: [
        { q: 'Vaccines arrived warm — what now?', a: 'Do not use them. Keep them aside (quarantine), raise a ticket under Delivery & returns with a photo. Our vet confirms and a fresh batch is sent.', topics: ['DELIVERY_RETURNS', 'PRODUCT_QUALITY'] },
        { q: 'How do cold-chain returns work?', a: 'Cold-chain products are returned only through FarmX pickup so the cold chain is verified. The refund is issued once the return is approved.', topics: ['DELIVERY_RETURNS'] },
        { q: 'Why do I need to share an OTP at delivery?', a: 'The delivery OTP proves the right farm received the goods. Never share it before the driver arrives.', topics: ['DELIVERY_RETURNS'] },
      ],
    },
    {
      code: 'PAYMENTS',
      title: 'Payments & refunds',
      items: [
        { q: 'When will I get my refund?', a: 'Refunds to UPI / card take 5–7 working days after approval; wallet refunds are instant.', topics: ['PAYMENT', 'DELIVERY_RETURNS'] },
        { q: 'Money was debited but the order failed', a: 'Failed payments are reversed automatically within 5–7 working days. Raise a Payment ticket if it takes longer.', topics: ['PAYMENT'] },
      ],
    },
  ],
  VENDOR: [
    { code: 'PAYOUTS', title: 'Payouts', items: [{ q: 'When is my settlement paid?', a: 'Same working day a sale is confirmed, to your verified bank account.', topics: ['SETTLEMENT'] }] },
  ],
  LOGISTICS: [
    { code: 'DELIVERY', title: 'Deliveries', items: [{ q: 'The farm OTP is not working', a: 'Ask the farmer to read the latest OTP from the app. If it still fails, raise a Delivery problem ticket; support can verify and override.', topics: ['DELIVERY_ISSUE'] }] },
  ],
  WAREHOUSE: [
    { code: 'SYSTEM', title: 'Handheld & system', items: [{ q: 'The handheld does not scan', a: 'Restart the app and clean the scanner window. If it still fails, raise a Handheld / system ticket.', topics: ['SYSTEM'] }] },
  ],
};

const PRIVACY_SECTIONS = [
  { heading: 'Information We Collect', body: 'Your name, phone, email, farm and delivery details, orders and payments (masked references only — never card or bank numbers), and app usage data.' },
  { heading: 'How We Use Your Information', body: 'To deliver orders, verify farms, process payments and refunds, provide support and vet advice, and improve FarmX.' },
  {
    heading: 'Information Sharing',
    body: 'We do not sell, trade, or rent your personal information to third parties. We may share data with:\n• Vendors and delivery partners assigned to your order (name and address only)\n• Payment processors for secure transactions\n• Analytics providers (anonymised data only)\n• Legal authorities when required by law',
  },
  { heading: 'Data Security', body: 'Data is encrypted in transit and at rest; access is role-based and every sensitive action is audited.' },
  { heading: 'Your Rights', body: 'You may access, correct or delete your data. Delete your account from Profile → Delete Account; personal data is erased after a 30-day grace period, except records the law requires us to keep.' },
  { heading: 'Cookies', body: 'The web app uses essential cookies for sign-in and optional analytics cookies you can turn off.' },
  { heading: 'Changes to This Policy', body: 'We will notify you in the app before material changes take effect.' },
];

async function main(): Promise<void> {
  const logger = createLogger({ service: 'support-seed', level: 'info', appEnv: 'local', version: '0' });
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error('DATABASE_URL is required');
  const db = getDatabase({ url, logger });

  const calendar =
    (await db.supportCalendar.findUnique({ where: { name: 'Support IST' } })) ??
    (await db.supportCalendar.create({
      data: {
        name: 'Support IST',
        timezone: 'Asia/Kolkata',
        weeklyHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 21 * 60 })),
      },
    }));

  for (const app of APPS) {
    for (const [i, t] of TOPICS[app].entries()) {
      await db.supportTopic.upsert({
        where: { app_code: { app, code: t.code } },
        create: { app, sortOrder: i, allowsEvidence: true, ...t },
        update: {},
      });
    }
    for (const [priority, s] of Object.entries(SLA) as [Priority, (typeof SLA)[Priority]][]) {
      await db.supportSlaPolicy.upsert({
        where: { app_priority: { app, priority } },
        create: { app, priority, calendarId: s.businessHoursOnly ? calendar.id : null, ...s },
        update: {},
      });
    }
    for (const [ci, c] of FAQS[app].entries()) {
      const category = await db.faqCategory.upsert({
        where: { app_code: { app, code: c.code } },
        create: { app, code: c.code, title: c.title, sortOrder: ci },
        update: {},
      });
      for (const [fi, f] of c.items.entries()) {
        const exists = await db.faq.findFirst({ where: { app, question: f.q }, select: { id: true } });
        if (exists === null)
          await db.faq.create({
            data: { app, categoryId: category.id, question: f.q, answer: f.a, topicCodes: f.topics ?? [], sortOrder: ci * 100 + fi },
          });
      }
    }
  }

  for (const r of RULES) {
    const exists = await db.supportPriorityRule.findFirst({ where: { name: r.name }, select: { id: true } });
    if (exists === null) await db.supportPriorityRule.create({ data: r });
  }

  const privacy = await db.legalDocument.findFirst({ where: { kind: 'PRIVACY_POLICY', app: null } });
  if (privacy === null)
    await db.legalDocument.create({
      data: {
        kind: 'PRIVACY_POLICY',
        app: null,
        version: 1,
        title: 'Privacy Policy',
        intro: 'FarmX is committed to protecting your personal data. This policy explains what we collect, why, and how you can control it.',
        sections: PRIVACY_SECTIONS,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        publishedBy: SYSTEM_USER,
        createdBy: SYSTEM_USER,
      },
    });

  await db.supportSetting.upsert({
    where: { key: 'chat' },
    create: { key: 'chat', value: { enabled: true, calendarId: calendar.id } },
    update: {},
  });

  logger.info({ calendarId: calendar.id }, 'support seed done');
  await closeDatabase();
}

await main();
