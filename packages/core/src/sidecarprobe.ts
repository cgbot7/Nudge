import { spawn } from 'node:child_process';

export interface SidecarPing {
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Start the popup's sidecar the way the popup does (node.exe plus its script, JSON lines on
 * stdio), send one ping and wait for the pong. nudge doctor uses it; nothing else needs it.
 */
export function pingSidecar(node: string, script: string, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<SidecarPing> {
  const started = performance.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    const child = spawn(node, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: opts.env ?? process.env });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (r: Omit<SidecarPing, 'ms'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve({ ...r, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)}s${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}` }), timeoutMs);
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('exit', (code) => finish({ ok: false, error: `the sidecar exited (code ${code})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}` }));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: unknown; result?: { pong?: unknown }; error?: { message?: string } };
          if (msg.id !== 'doctor') continue;
          if (msg.result?.pong === true) return finish({ ok: true });
          return finish({ ok: false, error: msg.error?.message ?? `unexpected answer: ${line.slice(0, 120)}` });
        } catch {
          return finish({ ok: false, error: `the sidecar wrote something that is not JSON to stdout: ${line.slice(0, 120)}` });
        }
      }
    });
    child.stdin.write(JSON.stringify({ id: 'doctor', method: 'ping' }) + '\n');
  });
}
