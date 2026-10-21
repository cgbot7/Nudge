// Talking to the Rust side (window.__TAURI__, withGlobalTauri) and, through it, to the
// Node sidecar: requests go out as JSON lines, replies come back as "sidecar" events.

interface TauriGlobal {
  core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void> };
}

declare global {
  interface Window {
    __TAURI__: TauriGlobal;
  }
}

export const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => window.__TAURI__.core.invoke<T>(cmd, args);
/** One line in %LOCALAPPDATA%\refs\logs\popup.log (release builds have no devtools). */
export const report = (line: string): void => void invoke('log_line', { line }).catch(() => {});
export const listen = <T>(event: string, handler: (payload: T) => void): Promise<() => void> => window.__TAURI__.event.listen<T>(event, (e) => handler(e.payload));

export class SidecarFailure extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SidecarClient {
  private next = 1;
  private pending = new Map<number, Pending>();

  async start(onDown: (message: string) => void): Promise<void> {
    await listen<string>('sidecar', (line) => this.onLine(line));
    await listen<null>('sidecar-restarted', () => this.failAll('the sidecar restarted; try again'));
    await listen<string>('sidecar-down', (message) => {
      this.failAll(message);
      onDown(message);
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SidecarFailure('timeout', `no answer to ${method} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      invoke<void>('sidecar_send', { line: JSON.stringify({ id, method, params }) }).catch((e: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new SidecarFailure('down', String(e)));
      });
    });
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new SidecarFailure(msg.error.code ?? 'error', msg.error.message ?? 'error'));
    else p.resolve(msg.result);
  }

  private failAll(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SidecarFailure('restarted', message));
      this.pending.delete(id);
    }
  }
}
