/** The subset of a PrismaClient used for health checks. */
export interface RawQueryClient {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
}

/** Readiness check for `@farmx/server` healthChecks: `{ postgres: createDbHealthCheck(prisma) }`. */
export const createDbHealthCheck = (client: RawQueryClient) => async (): Promise<void> => {
  await client.$queryRaw`SELECT 1`;
};
