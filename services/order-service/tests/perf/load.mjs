// Load generator for tests/perf/*.perf.ts, run in its OWN process so it never competes with the
// server for the event loop. Input (JSON file at argv[2]; a file because Windows caps argv at 32 KB): { url, rate, seconds, connections, targets:
// [{ path, user }] } — targets are cycled. Output (stdout, one JSON line): the autocannon result.
import { readFileSync } from 'node:fs';

import autocannon from 'autocannon';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let i = 0;
autocannon(
  {
    url: cfg.url,
    connections: cfg.connections ?? 20,
    ...(cfg.rate == null ? {} : { overallRate: cfg.rate }),
    duration: cfg.seconds,
    requests: [
      {
        setupRequest: (req) => {
          const t = cfg.targets[i % cfg.targets.length];
          i += 1;
          return { ...req, path: t.path, headers: { authorization: `Bearer ${t.user}` } };
        },
      },
    ],
  },
  (err, res) => {
    if (err) {
      process.stderr.write(String(err));
      process.exit(1);
    }
    process.stdout.write(
      `${JSON.stringify({
        requests: res.requests.total,
        rps: res.requests.average,
        non2xx: res.non2xx,
        errors: res.errors,
        latency: {
          p50: res.latency.p50,
          p90: res.latency.p90,
          p97_5: res.latency.p97_5,
          p99: res.latency.p99,
          max: res.latency.max,
        },
      })}\n`,
    );
  },
);
