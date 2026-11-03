import { spawn } from 'node:child_process';

export interface ProbeResult {
  ok: boolean;
  tools: string[];
  /** Protocol version the server agreed to. */
  protocol?: string;
  ms: number;
  error?: string;
}

/**
 * Start an MCP server over stdio, do the initialize handshake and list its tools, the way
 * an agent would at session start. A few JSON-RPC lines, so nudge doctor needs no MCP client.
 */
export function probeMcpServer(command: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ProbeResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: opts.env ?? process.env });
    let buffer = '';
    let stderr = '';
    let protocol: string | undefined;
    let settled = false;
    const finish = (r: Omit<ProbeResult, 'ms'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve({ ...r, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish({ ok: false, tools: [], error: `no answer within ${Math.round((opts.timeoutMs ?? 10_000) / 1000)}s${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}` }), opts.timeoutMs ?? 10_000);
    const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

    child.on('error', (e) => finish({ ok: false, tools: [], error: e.message }));
    child.on('exit', (code) => finish({ ok: false, tools: [], error: `the server exited (code ${code})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}` }));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { protocolVersion?: string; tools?: { name?: string }[] }; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          return finish({ ok: false, tools: [], error: `the server wrote something that is not JSON-RPC to stdout: ${line.slice(0, 120)}` });
        }
        if (msg.error) return finish({ ok: false, tools: [], error: msg.error.message ?? 'error reply' });
        if (msg.id === 1) {
          protocol = msg.result?.protocolVersion;
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          const tools = (msg.result?.tools ?? []).map((t) => String(t.name ?? '')).filter(Boolean);
          return finish({ ok: true, tools, protocol });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nudge-doctor', version: '0.1.0' } } });
  });
}
