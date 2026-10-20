import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export interface TestEnv {
  root: string;
  library: string;
  /** Folder outside the library for files to import. */
  work: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Fresh APPDATA, LOCALAPPDATA and library under a temp folder. Sets process.env too,
 * since core paths are resolved from the environment on every call.
 */
const sandboxes: string[] = [];
process.on('exit', () => {
  for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

export function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-test-'));
  sandboxes.push(root);
  const library = path.join(root, 'library');
  const work = path.join(root, 'work dir & more');
  fs.mkdirSync(work, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    GIT_AUTHOR_NAME: 'refs test',
    GIT_AUTHOR_EMAIL: 'refs-test@localhost',
    GIT_COMMITTER_NAME: 'refs test',
    GIT_COMMITTER_EMAIL: 'refs-test@localhost',
    NO_COLOR: '1',
    // Keep refs install and refs doctor away from the real profiles and scheduled task.
    REFS_DOCUMENTS_DIR: path.join(root, 'documents'),
    REFS_TASK_NAME: `refs-test-${path.basename(root)}`,
  };
  Object.assign(process.env, env);
  fs.mkdirSync(path.join(env.APPDATA!, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(env.APPDATA!, 'refs', 'config.json'), JSON.stringify({ library: library.replace(/\\/g, '/') }));
  return { root, library, work, env: { ...process.env, ...env } };
}

/** A SystemOps that never touches the machine; records what install would do. */
export function fakeSystem(documents: string, opts: { policy?: string; pwsh?: boolean; path?: string | null; taskExists?: boolean } = {}) {
  const calls: { writeUserPath: string[]; createTask: { name: string; xml: string }[] } = { writeUserPath: [], createTask: [] };
  let pathValue = opts.path === undefined ? '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps' : opts.path;
  let task = opts.taskExists ?? false;
  const sys = {
    info: () => ({
      documents,
      executionPolicy: opts.policy ?? 'RemoteSigned',
      pwshInstalled: opts.pwsh ?? true,
      userPath: pathValue === null ? null : { value: pathValue, kind: 'ExpandString' },
    }),
    writeUserPath(value: string) {
      calls.writeUserPath.push(value);
      pathValue = value;
    },
    taskExists: () => task,
    createTask(name: string, xml: string) {
      calls.createTask.push({ name, xml });
      task = true;
    },
  };
  return { sys, calls };
}

export function write(dir: string, name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// A real-looking token built at runtime so the test source itself never holds one.
export const FAKE_GITHUB_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0' + 'K1l2M3n4O5p6Q7r8';

export const DOCKER_MD = `# Docker basics

Notes I keep forgetting about containers and images.

## Containers

List running containers with docker ps, and all of them with docker ps -a.

\`\`\`bash
# remove all stopped containers
docker container prune
\`\`\`

## Images

Prune dangling images with docker image prune, or everything unused with docker image prune -a.

## Volumes

Named volumes survive container removal. List them with docker volume ls and inspect one with docker volume inspect.
`;

/** Minimal ZIP (stored, no compression) writer, enough for a DOCX. */
export function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** DOCX with paragraphs; `style` is a Word style id such as Heading1. */
export function makeDocx(paragraphs: { text: string; style?: string }[]): Buffer {
  const body = paragraphs
    .map((p) => {
      const pPr = p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : '';
      return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${xmlEscape(p.text)}</w:t></w:r></w:p>`;
    })
    .join('');
  return makeZip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`,
  });
}

/** PDF with one Helvetica text line per string; an empty page array gives a page with no text layer. */
export function makePdf(pages: string[][]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((lines, i) => {
    const content = lines.length ? `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
