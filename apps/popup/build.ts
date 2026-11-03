#!/usr/bin/env node
// Builds the popup: the frontend into apps/popup/dist, then the Tauri app with cargo.
//   node apps/popup/build.ts                  frontend, then cargo build --release
//   node apps/popup/build.ts --frontend-only  frontend only
//   node apps/popup/build.ts --check          frontend, then cargo check (tools\check)
// No bundler: Node's own type stripping turns src\*.ts into ES modules, and the
// runtime-only Vue build is copied next to them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');
const DIST = path.join(HERE, 'dist');
const TAURI = path.join(HERE, 'src-tauri');
const VUE = path.join(HERE, '..', '..', 'node_modules', 'vue', 'dist', 'vue.runtime.esm-browser.prod.js');
const VENDOR_VUE = './vendor/vue.runtime.esm-browser.prod.js';

/** Relative ".ts" imports become ".js"; "vue" becomes the vendored runtime file. */
export function rewriteImports(code: string): string {
  return code
    .replace(/(\bfrom\s+|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bfrom\s+)(['"])vue\2/g, `$1$2${VENDOR_VUE}$2`);
}

function buildFrontend(): void {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'vendor'), { recursive: true });
  for (const name of fs.readdirSync(SRC)) {
    const file = path.join(SRC, name);
    if (name.endsWith('.ts')) {
      const js = rewriteImports(stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' }));
      fs.writeFileSync(path.join(DIST, name.replace(/\.ts$/, '.js')), js);
    } else fs.copyFileSync(file, path.join(DIST, name));
  }
  fs.copyFileSync(path.join(HERE, 'index.html'), path.join(DIST, 'index.html'));
  fs.copyFileSync(VUE, path.join(DIST, VENDOR_VUE));
  console.log(`frontend: ${DIST}`);
}

// App icon: a teal rounded square with three white lines (a sheet), drawn with 4x4 supersampling.
function iconPixels(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const inRounded = (x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const bars: [number, number][] = [
    [0.28, 0.72],
    [0.28, 0.72],
    [0.28, 0.56],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const u = (x + (sx + 0.5) / 4) / size;
          const v = (y + (sy + 0.5) / 4) / size;
          if (!inRounded(u, v, 0.04, 0.04, 0.96, 0.96, 0.2)) continue;
          bg++;
          if (bars.some(([a, b], i) => inRounded(u, v, a, 0.3 + i * 0.16, b, 0.38 + i * 0.16, 0.04))) fg++;
        }
      }
      const i = (y * size + x) * 4;
      const t = bg ? fg / bg : 0;
      px[i] = Math.round(0x1f + (0xff - 0x1f) * t);
      px[i + 1] = Math.round(0x6f + (0xff - 0x6f) * t);
      px[i + 2] = Math.round(0x6b + (0xff - 0x6b) * t);
      px[i + 3] = Math.round((bg / 16) * 255);
    }
  }
  return px;
}

function png(size: number): Buffer {
  const pixels = iconPixels(size);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** ICO with PNG images inside (Windows Vista and later read those). */
function ico(sizes: number[]): Buffer {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    header[e] = s >= 256 ? 0 : s;
    header[e + 1] = s >= 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i]!.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i]!.length;
  });
  return Buffer.concat([header, ...images]);
}

function ensureIcons(): void {
  const dir = path.join(TAURI, 'icons');
  if (fs.existsSync(path.join(dir, 'icon.ico')) && fs.existsSync(path.join(dir, 'icon.png'))) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico([16, 24, 32, 48, 64, 256]));
  fs.writeFileSync(path.join(dir, 'icon.png'), png(256));
  console.log(`icons: ${dir}`);
}

function cargo(): string {
  const onPath = spawnSync('where.exe', ['cargo.exe'], { encoding: 'utf8', windowsHide: true });
  const found = onPath.status === 0 ? onPath.stdout.split(/\r?\n/).find((l) => l.trim()) : undefined;
  if (found) return found.trim();
  const home = path.join(process.env.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'bin', 'cargo.exe');
  if (fs.existsSync(home)) return home;
  throw new Error('cargo was not found on PATH or in %USERPROFILE%\\.cargo\\bin; install Rust with rustup first.');
}

function main(args: string[]): number {
  buildFrontend();
  ensureIcons();
  if (args.includes('--frontend-only')) return 0;
  const cmd = args.includes('--check') ? ['check', '--locked', '--quiet'] : ['build', '--release', '--locked'];
  const r = spawnSync(cargo(), cmd, { cwd: TAURI, stdio: 'inherit', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status === 0 && !args.includes('--check')) console.log(`popup: ${path.join(TAURI, 'target', 'release', 'nudge-popup.exe')}`);
  return r.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
