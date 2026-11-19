/**
 * Minimal in-memory Redis for tests: strings, hashes, TTLs, MULTI and the Lua scripts this
 * service uses (recognised by content and executed in JS with the same semantics).
 */
type Value = string | Map<string, string>;

export class FakeRedis {
  private readonly store = new Map<string, { value: Value; expiresAt: number | null }>();
  now = () => Date.now();

  private live(key: string) {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private hash(key: string): Map<string, string> {
    const entry = this.live(key);
    if (entry !== undefined && entry.value instanceof Map) return entry.value;
    const map = new Map<string, string>();
    this.store.set(key, { value: map, expiresAt: entry?.expiresAt ?? null });
    return map;
  }

  get(key: string): Promise<string | null> {
    const entry = this.live(key);
    return Promise.resolve(typeof entry?.value === 'string' ? entry.value : null);
  }

  mget(...keys: string[]): Promise<(string | null)[]> {
    return Promise.all(keys.map((key) => this.get(key)));
  }

  set(key: string, value: string, ...args: (string | number)[]): Promise<'OK' | null> {
    const nx = args.includes('NX');
    if (nx && this.live(key) !== undefined) return Promise.resolve(null);
    const exIndex = args.indexOf('EX');
    const ttl = exIndex >= 0 ? Number(args[exIndex + 1]) : null;
    this.store.set(key, { value, expiresAt: ttl === null ? null : this.now() + ttl * 1000 });
    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys)
      if (this.live(key) !== undefined && this.store.delete(key)) removed += 1;
    return Promise.resolve(removed);
  }

  incr(key: string): Promise<number> {
    const entry = this.live(key);
    const next = Number(typeof entry?.value === 'string' ? entry.value : 0) + 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return Promise.resolve(next);
  }

  expire(key: string, seconds: number): Promise<number> {
    const entry = this.live(key);
    if (entry === undefined) return Promise.resolve(0);
    entry.expiresAt = this.now() + seconds * 1000;
    return Promise.resolve(1);
  }

  ttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (entry === undefined) return Promise.resolve(-2);
    if (entry.expiresAt === null) return Promise.resolve(-1);
    return Promise.resolve(Math.ceil((entry.expiresAt - this.now()) / 1000));
  }

  hset(key: string, ...pairs: string[]): Promise<number> {
    const map = this.hash(key);
    for (let i = 0; i < pairs.length; i += 2) map.set(pairs[i] ?? '', pairs[i + 1] ?? '');
    return Promise.resolve(pairs.length / 2);
  }

  hget(key: string, field: string): Promise<string | null> {
    const entry = this.live(key);
    return Promise.resolve(entry?.value instanceof Map ? (entry.value.get(field) ?? null) : null);
  }

  hincrby(key: string, field: string, by: number): Promise<number> {
    const map = this.hash(key);
    const next = Number(map.get(field) ?? 0) + by;
    map.set(field, String(next));
    return Promise.resolve(next);
  }

  multi() {
    const ops: (() => Promise<unknown>)[] = [];
    const chain = {
      set: (...args: Parameters<FakeRedis['set']>) => (ops.push(() => this.set(...args)), chain),
      del: (...keys: string[]) => (ops.push(() => this.del(...keys)), chain),
      hset: (key: string, ...pairs: string[]) => (ops.push(() => this.hset(key, ...pairs)), chain),
      expire: (key: string, seconds: number) => (ops.push(() => this.expire(key, seconds)), chain),
      exec: async () => {
        const results: [null, unknown][] = [];
        for (const op of ops) results.push([null, await op()]);
        return results;
      },
    };
    return chain;
  }

  /** Executes the known Lua scripts of this codebase. */
  async eval(
    script: string,
    _numKeys: number,
    key: string,
    ...args: (string | number)[]
  ): Promise<unknown> {
    if (script.includes('"INCR"')) {
      // Rate limiter: INCR + EXPIRE on first hit, returns [count, ttl].
      const count = await this.incr(key);
      if (count === 1) await this.expire(key, Number(args[0]));
      return [count, await this.ttl(key)];
    }
    if (script.includes('HGET') && script.includes('"code"')) {
      // OTP verify.
      const stored = await this.hget(key, 'code');
      if (stored === null) return -1;
      if (stored === String(args[0])) {
        await this.del(key);
        return 1;
      }
      const attempts = await this.hincrby(key, 'attempts', 1);
      if (attempts >= Number(args[1])) {
        await this.del(key);
        return -2;
      }
      return 0;
    }
    if (script.includes('EXISTS')) {
      // MFA challenge failure counter.
      if (this.live(key) === undefined) return -1;
      const n = await this.hincrby(key, 'attempts', 1);
      if (n >= Number(args[0])) await this.del(key);
      return n;
    }
    throw new Error('FakeRedis: unknown script');
  }

  quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }

  keys(): string[] {
    return [...this.store.keys()].filter((key) => this.live(key) !== undefined);
  }
}
