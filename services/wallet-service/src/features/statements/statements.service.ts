import { AppError, ErrorCode } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import { type StatementRow, renderStatementPdf } from './statements.pdf.js';

type Deps = Pick<Cradle, 'ledgerService' | 'rewardsService'>;

const MAX_DAYS = 366;
const MAX_ROWS = 2_000;
const IST_MS = 330 * 60_000;

/** "2026-10-01" → 00:00 IST that day (as a UTC instant). */
export const istStart = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) - IST_MS);
};

const refuse = (message: string, reason: string, extra: object = {}) =>
  new AppError(ErrorCode.VALIDATION_ERROR, message, 422, { details: { reason, ...extra } });

export interface StatementQuery {
  ledger: 'WALLET' | 'POINTS';
  /** YYYY-MM-DD (IST), inclusive; default 30 days before `to`. */
  from?: string;
  /** YYYY-MM-DD (IST), inclusive; default today. */
  to?: string;
}

/** "Download statement" (D-54): own wallet or points ledger for an IST date range, as a PDF. */
export class StatementsService {
  constructor(private readonly deps: Deps) {}

  async pdf(userId: string, q: StatementQuery): Promise<{ file: Buffer; filename: string }> {
    const todayIst = new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
    const toDay = q.to ?? todayIst;
    const end = new Date(istStart(toDay).getTime() + 86_400_000);
    const start =
      q.from === undefined ? new Date(end.getTime() - 30 * 86_400_000) : istStart(q.from);
    if (start >= end) throw refuse('`from` must not be after `to`', 'BAD_RANGE');
    if (end.getTime() - start.getTime() > MAX_DAYS * 86_400_000)
      throw refuse(`A statement covers at most ${String(MAX_DAYS)} days`, 'RANGE_TOO_LONG');

    const data = await this.load(userId, q.ledger, start, end);
    if (data.truncated)
      throw refuse(
        `More than ${String(MAX_ROWS)} entries in this period; choose a shorter range`,
        'TOO_MANY_ROWS',
      );
    const file = await renderStatementPdf({
      ledger: q.ledger,
      userId,
      from: start,
      to: end,
      opening: data.opening,
      closing: data.closing,
      rows: data.rows,
      generatedAt: new Date(),
    });
    const fromDay = new Date(start.getTime() + IST_MS).toISOString().slice(0, 10);
    return {
      file,
      filename: `farmx-${q.ledger === 'WALLET' ? 'wallet' : 'points'}-statement-${fromDay}_${toDay}.pdf`,
    };
  }

  /** One read of the chosen ledger, as statement rows. */
  private async load(
    userId: string,
    ledger: StatementQuery['ledger'],
    start: Date,
    end: Date,
  ): Promise<{ opening: bigint; closing: bigint; rows: StatementRow[]; truncated: boolean }> {
    if (ledger === 'WALLET') {
      const d = await this.deps.ledgerService.statement(userId, start, end, MAX_ROWS);
      return {
        ...d,
        rows: d.rows.map((t) => ({
          at: t.createdAt,
          title: t.title,
          subtitle: t.subtitle,
          reference: t.journalNo,
          amount: BigInt(t.amountPaise),
          balance: t.balanceAfterPaise === null ? null : BigInt(t.balanceAfterPaise),
        })),
      };
    }
    const d = await this.deps.rewardsService.statement(userId, start, end, MAX_ROWS);
    return {
      ...d,
      rows: d.rows.map((e) => ({
        at: e.createdAt,
        title: e.title,
        subtitle: e.subtitle,
        reference: e.journalNo,
        amount: BigInt(e.deltaPts),
        balance: BigInt(e.availableAfter),
      })),
    };
  }
}
