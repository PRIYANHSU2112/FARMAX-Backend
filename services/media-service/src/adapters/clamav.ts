import { Socket } from 'node:net';

/**
 * Minimal clamd client (INSTREAM over TCP): sends the bytes in ≤ 64 KiB chunks, returns the verdict.
 * `stream: OK` → clean; `stream: <name> FOUND` → infected. Any other answer or a timeout throws.
 */
export async function scanWithClamd(
  body: Buffer,
  host: string,
  port: number,
  timeoutMs = 15_000,
): Promise<{ clean: boolean; signature: string | null }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let answer = '';
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error('clamd timeout'));
    });
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('utf8');
    });
    socket.on('close', () => {
      const text = answer.replace(/\0/g, '').trim();
      if (text.endsWith('OK')) return resolve({ clean: true, signature: null });
      const found = /stream: (.+) FOUND$/.exec(text);
      if (found !== null) return resolve({ clean: false, signature: found[1] ?? 'unknown' });
      reject(new Error(`clamd: unexpected answer "${text.slice(0, 80)}"`));
    });
    socket.connect(port, host, () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < body.length; i += 65_536) {
        const chunk = body.subarray(i, i + 65_536);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length, 0);
        socket.write(size);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
  });
}
