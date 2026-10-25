import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';
import { createPool, one } from '../db.js';

/**
 * Sao lưu cơ sở dữ liệu (QL-16, kế hoạch mục 11).
 *   npm run backup          sao lưu bằng pg_dump vào MEDONE_BACKUP_DIR (mặc định thư mục backups ở gốc dự án)
 *   npm run backup:verify   khôi phục bản mới nhất vào một cơ sở dữ liệu tạm, so số dòng các bảng chính rồi xóa cơ sở tạm
 * Mật khẩu cơ sở dữ liệu truyền qua biến môi trường PGPASSWORD cho pg_dump, không đưa lên dòng lệnh, không in ra.
 * Nên chép thư mục sao lưu sang ổ khác hoặc nơi khác định kỳ: bản sao lưu nằm cùng máy không chống được hỏng máy.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Đọc mỗi lần chạy để kiểm thử đổi được thư mục */
const backupDir = () => process.env.MEDONE_BACKUP_DIR || join(ROOT, 'backups');
const KEEP_DAYS = Math.max(7, Number(process.env.MEDONE_BACKUP_KEEP_DAYS) || 30);
const CHECK_TABLES = ['incidents', 'transfers', 'patients', 'users', 'audit_events', 'stock_moves', 'charges'];

function pgEnv(url: string) {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname || 'localhost', PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.MEDONE_PG_BIN ? join(process.env.MEDONE_PG_BIN, cmd) : cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'ENOENT' ? `Không tìm thấy ${cmd}: cài PostgreSQL client hoặc đặt MEDONE_PG_BIN` : e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} lỗi (mã ${code}): ${err.trim().slice(0, 500)}`))));
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function counts(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const out: Record<string, number> = {};
    for (const t of CHECK_TABLES) out[t] = Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    return out;
  } finally { await c.end(); }
}

export async function backup(actor = 'npm run backup') {
  const pool = createPool();
  const row = await one(pool, `INSERT INTO ops_backups(kind, actor) VALUES ('sao_luu', $1) RETURNING id`, [actor]);
  try {
    const DIR = backupDir();
    mkdirSync(DIR, { recursive: true });
    const stamp = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const file = join(DIR, `medone-${stamp}.dump`);
    // Đếm trước và sau khi dump: bản sao lưu là ảnh chụp ở giữa, số dòng khôi phục phải nằm trong khoảng này
    const before = await counts(config.databaseUrl);
    await run('pg_dump', ['--format=custom', '--no-owner', '--file', file], pgEnv(config.databaseUrl));
    chmodSync(file, 0o400);
    const size = statSync(file).size;
    const hash = await sha256(file);
    const detail = { before, after: await counts(config.databaseUrl) };
    await pool.query(`UPDATE ops_backups SET finished_at = now(), ok = true, file = $2, size_bytes = $3, sha256 = $4, detail = $5 WHERE id = $1`,
      [row.id, basename(file), size, hash, JSON.stringify(detail)]);
    const removed = prune(DIR);
    console.log(`Đã sao lưu ${basename(file)} (${Math.round(size / 1024)} KB)${removed ? `, xóa ${removed} bản cũ hơn ${KEEP_DAYS} ngày` : ''}`);
  } catch (e) {
    await pool.query(`UPDATE ops_backups SET finished_at = now(), ok = false, error = $2 WHERE id = $1`, [row.id, (e as Error).message]);
    throw e;
  } finally { await pool.end(); }
}

/** Giữ các bản trong KEEP_DAYS ngày, luôn giữ ít nhất 7 bản mới nhất */
function prune(DIR: string) {
  const files = readdirSync(DIR).filter((f) => /^medone-\d{8}-\d{6}\.dump$/.test(f)).sort().reverse();
  let removed = 0;
  for (const f of files.slice(7)) {
    const p = join(DIR, f);
    if (Date.now() - statSync(p).mtimeMs > KEEP_DAYS * 86400000) {
      chmodSync(p, 0o600);
      unlinkSync(p);
      removed++;
    }
  }
  return removed;
}

export async function verify(actor = 'npm run backup:verify') {
  const pool = createPool();
  const last = await one(pool, `SELECT * FROM ops_backups WHERE kind = 'sao_luu' AND ok ORDER BY started_at DESC LIMIT 1`);
  const row = await one(pool, `INSERT INTO ops_backups(kind, actor, file) VALUES ('thu_khoi_phuc', $1, $2) RETURNING id`, [actor, last?.file ?? null]);
  const env = pgEnv(config.databaseUrl);
  const temp = `${env.PGDATABASE}_khoi_phuc_thu`;
  const tempUrl = new URL(config.databaseUrl); tempUrl.pathname = `/${temp}`;
  try {
    if (!last) throw new Error('Chưa có bản sao lưu thành công');
    const file = join(backupDir(), last.file);
    if ((await sha256(file)) !== last.sha256) throw new Error(`Tệp ${last.file} không khớp mã băm lúc sao lưu: tệp đã bị sửa hoặc hỏng`);
    await pool.query(`DROP DATABASE IF EXISTS "${temp}"`);
    await pool.query(`CREATE DATABASE "${temp}"`);
    await run('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', temp, file], env);
    const restored = await counts(tempUrl.toString());
    const { before, after } = last.detail as { before: Record<string, number>; after: Record<string, number> };
    const diff = CHECK_TABLES.filter((t) => !(restored[t] >= before[t] && restored[t] <= after[t]))
      .map((t) => `${t}: ${restored[t]} (lúc sao lưu ${before[t]}–${after[t]})`);
    if (diff.length) throw new Error(`Số dòng sau khôi phục không khớp: ${diff.join('; ')}`);
    await pool.query(`UPDATE ops_backups SET finished_at = now(), ok = true, size_bytes = $2, sha256 = $3, detail = $4 WHERE id = $1`,
      [row.id, last.size_bytes, last.sha256, JSON.stringify(restored)]);
    console.log(`Thử khôi phục ${last.file} thành công: ${Object.entries(restored).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  } catch (e) {
    await pool.query(`UPDATE ops_backups SET finished_at = now(), ok = false, error = $2 WHERE id = $1`, [row.id, (e as Error).message]);
    throw e;
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS "${temp}"`).catch(() => {});
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (process.argv[2] === 'verify' ? verify() : backup()).catch((e) => { console.error(e.message); process.exit(1); });
}
