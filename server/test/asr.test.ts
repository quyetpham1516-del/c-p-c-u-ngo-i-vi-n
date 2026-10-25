import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { asrConfig, transcribePending } from '../src/asr.js';
import { config } from '../src/config.js';
import { freshApp, login } from './helpers.js';

let app: FastifyInstance; let pool: pg.Pool;
let recDir = ''; let asr: Server;
let asrMode: 'ok' | 'fail' = 'ok';
const received: { auth?: string; body: string }[] = [];
const TEXT = 'Alo cấp cứu, mẹ tôi tự nhiên ngừng thở, đang ở hẻm 12 đường Lê Lợi';

const pbx = (url: string, form: Record<string, string>) => app.inject({
  method: 'POST', url, payload: new URLSearchParams(form).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-medone-telephony-key': config.telephonyKey },
});
/** Một cuộc gọi trọn vẹn qua tổng đài: chuông, máy lẻ 101 nhấc, gác máy có ghi âm */
async function fullCall(pbxId: string, answered = true) {
  await pbx('/api/telephony/ring', { phone: '0909000111', pbxId });
  if (answered) await pbx('/api/telephony/answered', { pbxId, ext: '101' });
  writeFileSync(join(recDir, `${pbxId}.wav`), Buffer.alloc(3000, 3));
  await pbx('/api/telephony/hangup', { pbxId, recording: `${pbxId}.wav` });
  return (await pool.query('SELECT id, incident_id, transcript_status FROM calls WHERE pbx_id = $1', [pbxId])).rows[0];
}

beforeAll(async () => {
  recDir = mkdtempSync(join(tmpdir(), 'medone-chep-loi-'));
  process.env.MEDONE_RECORDINGS_DIR = recDir;
  for (const k of ['MEDONE_ARI_URL', 'MEDONE_ARI_USER', 'MEDONE_ARI_PASSWORD', 'MEDONE_ASR_URL']) delete process.env[k];
  asr = createServer((req, res) => {
    let body = '';
    req.setEncoding('latin1');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (asrMode === 'fail' || req.url !== '/v1/audio/transcriptions') { res.statusCode = 500; return res.end('{}'); }
      res.end(JSON.stringify({ text: ` ${TEXT} ` }));
    });
  });
  await new Promise<void>((r) => asr.listen(0, '127.0.0.1', r));
  ({ app, pool } = await freshApp());
  const admin = await login(app, 'admin');
  const dpv06 = (await pool.query(`SELECT id FROM users WHERE username = 'dpv06'`)).rows[0].id;
  await admin('PUT', '/api/telephony/extensions/101', { userId: dpv06 });
});
afterAll(async () => {
  for (const k of ['MEDONE_RECORDINGS_DIR', 'MEDONE_ASR_URL', 'MEDONE_ASR_KEY']) delete process.env[k];
  await app.close(); await pool.end(); asr.close();
  rmSync(recDir, { recursive: true, force: true });
});

describe('chép lời cuộc gọi', () => {
  it('chưa cài máy chép lời: không xếp hàng, nút chép lại báo 503', async () => {
    const c = await fullCall('asr.0');
    expect(c.transcript_status).toBeNull();
    const tc = await login(app, 'truongca');
    expect((await tc('POST', `/api/calls/${c.id}/transcript`)).http).toBe(503);
    expect((await tc('GET', `/api/calls/${c.id}/transcript`)).enabled).toBe(false);
  });

  it('có máy chép lời: gác máy xếp hàng, chép xong lưu lời thoại; gửi tiếng Việt, kèm khóa', async () => {
    Object.assign(process.env, { MEDONE_ASR_URL: `http://127.0.0.1:${(asr.address() as AddressInfo).port}/v1/`, MEDONE_ASR_KEY: 'khoa-thu' });
    const c = await fullCall('asr.1');
    expect(c.transcript_status).toBe('cho');
    const r = await transcribePending(pool, asrConfig());
    expect(r).toEqual({ done: 1, failed: 0 });
    expect(received.at(-1)!.auth).toBe('Bearer khoa-thu');
    expect(received.at(-1)!.body).toContain('name="language"\r\n\r\nvi');
    expect(received.at(-1)!.body).toContain('filename="asr.1.wav"');
    const row = (await pool.query('SELECT transcript, transcript_status, transcript_model FROM calls WHERE id = $1', [c.id])).rows[0];
    expect(row).toEqual({ transcript: TEXT, transcript_status: 'xong', transcript_model: 'whisper-1' });
  });

  it('cuộc gọi bỏ dở không chép', async () => {
    const c = await fullCall('asr.2', false);
    expect(c.transcript_status).toBeNull();
  });

  it('chỉ trưởng ca, QLCL, quản trị, Ban Giám đốc xem lời thoại; mỗi lượt xem ghi nhật ký', async () => {
    const c = (await pool.query(`SELECT id, incident_id FROM calls WHERE pbx_id = 'asr.1'`)).rows[0];
    const t = await (await login(app, 'qlcl'))('GET', `/api/calls/${c.id}/transcript`);
    expect(t).toMatchObject({ status: 'xong', text: TEXT, enabled: true });
    expect((await (await login(app, 'dpv06'))('GET', `/api/calls/${c.id}/transcript`)).http).toBe(403);
    expect((await (await login(app, 'bs.als'))('GET', `/api/calls/${c.id}/transcript`)).http).toBe(403);
    const n = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'call.transcript_viewed' AND entity_id = $1`, [c.id]);
    expect(n.rows[0].n).toBe(1);
    const list = await (await login(app, 'dpv06'))('GET', `/api/incidents/${c.incident_id}/calls`);
    expect(list.data[0].transcript_status).toBe('xong');
    expect(list.data[0].transcript).toBeUndefined();
  });

  it('tìm cuộc gọi theo lời thoại', async () => {
    const tc = await login(app, 'truongca');
    const r = await tc('GET', `/api/calls/search?q=${encodeURIComponent('ngừng thở')}`);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].snippet).toContain('«ngừng»');
    expect(r.data[0].incident_code).toMatch(/^MD-/);
    expect((await tc('GET', `/api/calls/search?q=${encodeURIComponent('gãy chân')}`)).data).toHaveLength(0);
    expect((await (await login(app, 'dpv06'))('GET', '/api/calls/search?q=abc')).http).toBe(403);
  });

  it('máy chép lời lỗi: thử 3 lần rồi báo lỗi; chép lại được', async () => {
    asrMode = 'fail';
    const c = await fullCall('asr.3');
    for (let i = 0; i < 3; i++) await transcribePending(pool, asrConfig());
    let row = (await pool.query('SELECT transcript_status, transcript_attempts, transcript_error FROM calls WHERE id = $1', [c.id])).rows[0];
    expect(row).toMatchObject({ transcript_status: 'loi', transcript_attempts: 3, transcript_error: 'HTTP 500' });
    expect(await transcribePending(pool, asrConfig())).toEqual({ done: 0, failed: 0 });
    asrMode = 'ok';
    expect((await (await login(app, 'truongca'))('POST', `/api/calls/${c.id}/transcript`)).status).toBe('cho');
    await transcribePending(pool, asrConfig());
    row = (await pool.query('SELECT transcript_status FROM calls WHERE id = $1', [c.id])).rows[0];
    expect(row.transcript_status).toBe('xong');
  });
});
