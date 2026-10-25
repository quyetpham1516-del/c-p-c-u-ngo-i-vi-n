import { hostname } from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, withTx } from '../db.js';
import { HttpError, incidentSummary } from '../domain.js';
import { actorOf, EOC_ROLES, guard, type Ctx, type Role } from '../http.js';
import {
  ackCaseFeedback, addMaintenance, addVehicleDoc, arrestRegistry, BLOCKING_DOCS, caseCrew, declareMci, DOC_WARN_DAYS, endMci, fleetCompliance, ICS_ROLES,
  incidentTrack, MAINTENANCE_KIND, MCI_LEVEL, MCI_SUPPORT_THRESHOLD, mciBoard, myCaseFeedback, recordOdometer, REVIEW_CRITERIA, REVIEW_REASONS, REVIEW_SCORE,
  reviewQueue, saveArrestOutcome, saveCaseReview, saveVictim, startCaseReview, TRIAGE, UTSTEIN_LABELS, utsteinReport, VEHICLE_DOC_KIND, VICTIM_STATUS,
} from '../ops.js';

const REVIEWERS: Role[] = ['qa', 'supervisor', 'admin', 'director'];
const OUTCOME_EDIT: Role[] = ['qa', 'admin', 'director'];
const MCI_COMMAND: Role[] = ['supervisor', 'admin'];
const MCI_VIEW: Role[] = [...EOC_ROLES, 'crew', 'qa', 'director'];
const FLEET_VIEW: Role[] = [...EOC_ROLES, 'crew', 'technician', 'qa', 'director', 'accountant'];
const FLEET_EDIT: Role[] = ['technician', 'supervisor', 'admin'];
const TRACK_VIEW: Role[] = [...EOC_ROLES, 'qa', 'director'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const opt = (n = 2000) => z.string().trim().max(n).nullish();
const idParam = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
const vehicleParam = (p: unknown) => z.object({ id: z.string().min(1).max(40) }).parse(p).id;
const vnToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 7 * 3600_000 - n * 86400000).toISOString().slice(0, 10);
const range = (q: unknown, days = 30) => {
  const r = z.object({ from: date.optional(), to: date.optional() }).parse(q);
  return { from: r.from ?? daysAgo(days), to: r.to ?? vnToday() };
};

export function registerOps(app: FastifyInstance, { pool, hub }: Ctx) {
  const pushIncident = async (id: string) => hub.publish({ type: 'incident', id, incident: await incidentSummary(pool, id) });

  /** Kíp chỉ thao tác trên xe mình đang đăng nhập ca */
  async function assertCrewVehicle(req: FastifyRequest, vehicleId: string) {
    if (req.user.role !== 'crew') return;
    const s = await one(pool, 'SELECT 1 FROM crew_shifts WHERE user_id = $1 AND vehicle_id = $2 AND ended_at IS NULL', [req.user.id, vehicleId]);
    if (!s) throw new HttpError(403, 'Bạn không đăng nhập ca trên xe này');
  }

  app.get('/api/ops/meta', { preHandler: guard() }, async () => ({
    utstein: UTSTEIN_LABELS, reviewReasons: REVIEW_REASONS, reviewCriteria: REVIEW_CRITERIA, reviewScore: REVIEW_SCORE,
    triage: TRIAGE, victimStatus: VICTIM_STATUS, icsRoles: ICS_ROLES, mciLevel: MCI_LEVEL, mciSupportThreshold: MCI_SUPPORT_THRESHOLD,
    vehicleDocKind: VEHICLE_DOC_KIND, blockingDocs: BLOCKING_DOCS, docWarnDays: DOC_WARN_DAYS, maintenanceKind: MAINTENANCE_KIND,
  }));

  /** Tên máy chủ trong mạng nội bộ (mDNS .local): tem QR in theo tên này không phụ thuộc IP */
  app.get('/api/ops/server-name', { preHandler: guard() }, async () => {
    const h = hostname().toLowerCase();
    return { hostname: h.includes('.') ? h : `${h}.local` };
  });

  /* ---------- Utstein ---------- */

  app.get('/api/ops/arrests', { preHandler: guard(...REVIEWERS) }, async (req) => {
    const r = range(req.query, 365);
    const rows = await arrestRegistry(pool, r.from, r.to);
    const pop = await one(pool, `SELECT value FROM ops_settings WHERE key = 'population_served'`);
    return { ...r, rows, report: utsteinReport(rows, pop?.value ? Number(pop.value) : null) };
  });

  app.put('/api/ops/arrests/:id/outcome', { preHandler: guard(...OUTCOME_EDIT) }, async (req) => {
    const b = z.object({
      admitted: z.boolean().nullish(), survived30d: z.boolean().nullish(), dischargedOn: date.nullish(), cpc: z.number().int().min(1).max(5).nullish(), note: opt(),
    }).parse(req.body);
    return withTx(pool, (tx) => saveArrestOutcome(tx, actorOf(req), idParam(req.params), b));
  });

  /* ---------- Rà soát ca ---------- */

  app.get('/api/ops/case-reviews', { preHandler: guard(...REVIEWERS) }, async (req) => {
    const r = range(req.query, 14);
    const open = z.object({ open: z.enum(['0', '1']).default('1') }).parse(req.query).open === '1';
    return { ...r, rows: await reviewQueue(pool, r.from, r.to, open) };
  });

  app.post('/api/ops/case-reviews', { preHandler: guard(...REVIEWERS) }, async (req) => {
    const b = z.object({ incidentId: z.string().uuid().optional(), incidentCode: z.string().trim().max(40).optional(), reason: opt(500) }).parse(req.body);
    let id = b.incidentId;
    if (!id && b.incidentCode) id = (await one(pool, 'SELECT id FROM incidents WHERE code = $1', [b.incidentCode.toUpperCase()]))?.id;
    if (!id) throw new HttpError(404, 'Không tìm thấy ca');
    return withTx(pool, (tx) => startCaseReview(tx, actorOf(req), id!, b.reason ?? null));
  });

  app.get('/api/ops/case-reviews/:id', { preHandler: guard(...REVIEWERS) }, async (req) => {
    const r = await one(pool, `SELECT cr.*, u.full_name AS reviewer_name, i.code AS incident_code, i.final_priority, i.chief_complaint, i.address, i.created_at AS incident_at,
                                      i.suggested_priority, i.override_reason
                                 FROM ops_case_reviews cr JOIN users u ON u.id = cr.reviewer_id JOIN incidents i ON i.id = cr.incident_id WHERE cr.id = $1`, [idParam(req.params)]);
    if (!r) throw new HttpError(404, 'Không tìm thấy phiếu rà soát');
    const [crew, times, transfers, acks, capa, track] = await Promise.all([
      caseCrew(pool, r.incident_id),
      many(pool, `SELECT code, at FROM incident_times WHERE incident_id = $1 ORDER BY at`, [r.incident_id]),
      many(pool, `SELECT id, transfer_number, vehicle_id, status, epcr->'diagnosis'->>'text' AS diagnosis, epcr->'disposition'->>'type' AS disposition,
                         epcr->'disposition'->>'hospital' AS hospital, (epcr->'arrest'->>'present')::boolean AS arrest FROM transfers WHERE incident_id = $1`, [r.incident_id]),
      many(pool, `SELECT a.*, u.full_name FROM ops_review_acks a JOIN users u ON u.id = a.user_id WHERE a.review_id = $1`, [r.id]),
      many(pool, `SELECT c.id, c.description, c.status, c.due_date, u.full_name AS owner_name FROM capa_actions c JOIN users u ON u.id = c.owner_id WHERE c.case_review_id = $1`, [r.id]),
      incidentTrack(pool, r.incident_id),
    ]);
    return { ...r, crew, times, transfers, acks, capa, track: track.vehicles.map(({ points, ...v }) => ({ ...v, points: points.length })) };
  });

  app.put('/api/ops/case-reviews/:id', { preHandler: guard(...REVIEWERS) }, async (req) => {
    const b = z.object({ scores: z.record(z.string(), z.string()), summary: opt(), goodPractice: opt(), learning: opt(), finish: z.boolean().default(false) }).parse(req.body);
    return withTx(pool, (tx) => saveCaseReview(tx, actorOf(req), idParam(req.params), b));
  });

  /** Kíp xem phản hồi bình ca của mình */
  app.get('/api/ops/my-feedback', { preHandler: guard() }, async (req) => myCaseFeedback(pool, req.user.id));
  app.post('/api/ops/my-feedback/:id/ack', { preHandler: guard() }, async (req) => {
    const b = z.object({ comment: opt(1000) }).parse(req.body ?? {});
    await withTx(pool, (tx) => ackCaseFeedback(tx, actorOf(req), idParam(req.params), b.comment ?? null));
    return { ok: true };
  });

  /* ---------- GPS ---------- */

  app.get('/api/ops/incidents/:id/track', { preHandler: guard(...TRACK_VIEW) }, async (req) => incidentTrack(pool, idParam(req.params)));
  app.get('/api/ops/tracks/by-code/:code', { preHandler: guard(...TRACK_VIEW) }, async (req) => {
    const code = z.object({ code: z.string().trim().min(3).max(40) }).parse(req.params).code.toUpperCase();
    const inc = await one(pool, 'SELECT id FROM incidents WHERE code = $1', [code]);
    if (!inc) throw new HttpError(404, 'Không tìm thấy ca');
    return incidentTrack(pool, inc.id);
  });

  /* ---------- Đông nạn nhân ---------- */

  app.get('/api/ops/mci', { preHandler: guard(...MCI_VIEW) }, async () =>
    many(pool, `SELECT i.id, i.code, i.address, i.mci_level, i.mci_declared_at, i.mci_ended_at,
                       (SELECT count(*)::int FROM ops_mci_victims v WHERE v.incident_id = i.id) AS victims
                  FROM incidents i WHERE i.mci_declared_at IS NOT NULL ORDER BY (i.mci_ended_at IS NULL) DESC, i.mci_declared_at DESC LIMIT 50`));

  app.get('/api/ops/mci/:id', { preHandler: guard(...MCI_VIEW) }, async (req) => mciBoard(pool, idParam(req.params)));

  app.post('/api/ops/mci/:id/declare', { preHandler: guard(...MCI_COMMAND) }, async (req) => {
    const id = idParam(req.params);
    const roleKeys = Object.keys(ICS_ROLES) as [string, ...string[]];
    const b = z.object({ level: z.number().int().min(1).max(3), note: opt(1000), roles: z.partialRecord(z.enum(roleKeys), z.string().max(200)).optional() }).parse(req.body);
    await withTx(pool, (tx) => declareMci(tx, actorOf(req), id, b));
    await pushIncident(id);
    return mciBoard(pool, id);
  });

  app.post('/api/ops/mci/:id/end', { preHandler: guard(...MCI_COMMAND) }, async (req) => {
    const id = idParam(req.params);
    const b = z.object({ note: z.string().trim().min(3).max(1000) }).parse(req.body);
    await withTx(pool, (tx) => endMci(tx, actorOf(req), id, b.note));
    await pushIncident(id);
    return mciBoard(pool, id);
  });

  const victimBody = z.object({
    tag: z.string().trim().min(1).max(20), triage: z.enum(['do', 'vang', 'xanh', 'den']), sex: z.enum(['M', 'F', 'U']).nullish(), ageGroup: opt(30), note: opt(500),
    status: z.enum(['hien_truong', 'dang_chuyen', 'da_den_vien', 'tai_cho', 'tu_vong']).default('hien_truong'),
    vehicleId: z.string().max(40).nullish(), hospital: opt(200), transferId: z.string().uuid().nullish(),
  });
  async function assertVictimAccess(req: FastifyRequest, incidentId: string) {
    if (req.user.role !== 'crew') return;
    const ok = await one(pool, `SELECT 1 FROM assignments a JOIN crew_shifts cs ON cs.vehicle_id = a.vehicle_id AND cs.ended_at IS NULL
                                 WHERE a.incident_id = $1 AND cs.user_id = $2 AND a.ended_at IS NULL`, [incidentId, req.user.id]);
    if (!ok) throw new HttpError(403, 'Xe của bạn không được giao cho ca này');
  }
  const VICTIM_ROLES: Role[] = ['crew', 'dispatcher', 'supervisor', 'admin'];
  app.post('/api/ops/mci/:id/victims', { preHandler: guard(...VICTIM_ROLES) }, async (req) => {
    const id = idParam(req.params);
    await assertVictimAccess(req, id);
    const row = await withTx(pool, (tx) => saveVictim(tx, actorOf(req), id, null, victimBody.parse(req.body)));
    await pushIncident(id);
    return row;
  });
  app.put('/api/ops/mci/:id/victims/:victimId', { preHandler: guard(...VICTIM_ROLES) }, async (req) => {
    const p = z.object({ id: z.string().uuid(), victimId: z.string().uuid() }).parse(req.params);
    await assertVictimAccess(req, p.id);
    const row = await withTx(pool, (tx) => saveVictim(tx, actorOf(req), p.id, p.victimId, victimBody.parse(req.body)));
    await pushIncident(p.id);
    return row;
  });

  /* ---------- Xe ---------- */

  app.get('/api/ops/fleet', { preHandler: guard(...FLEET_VIEW) }, async () => {
    const [vehicles, compliance] = await Promise.all([
      many(pool, `SELECT v.id, v.plate, v.type, v.station_id, s.name AS station_name, v.status FROM vehicles v JOIN stations s ON s.id = v.station_id ORDER BY v.id`),
      fleetCompliance(pool),
    ]);
    return vehicles.map((v) => ({ ...v, ...compliance[v.id] }));
  });

  app.get('/api/ops/fleet/:id', { preHandler: guard(...FLEET_VIEW) }, async (req) => {
    const id = vehicleParam(req.params);
    const [compliance, docs, maintenance, odometer] = await Promise.all([
      fleetCompliance(pool, [id]),
      many(pool, `SELECT d.*, u.full_name AS created_by_name FROM ops_vehicle_docs d LEFT JOIN users u ON u.id = d.created_by WHERE d.vehicle_id = $1 ORDER BY d.kind, d.expires_on DESC`, [id]),
      many(pool, `SELECT m.*, s.name AS supplier_name, u.full_name AS recorded_by_name FROM ops_maintenance m LEFT JOIN qm_suppliers s ON s.id = m.supplier_id
                   LEFT JOIN users u ON u.id = m.recorded_by WHERE m.vehicle_id = $1 ORDER BY m.done_on DESC, m.created_at DESC LIMIT 100`, [id]),
      many(pool, `SELECT o.*, u.full_name AS user_name FROM ops_odometer o LEFT JOIN users u ON u.id = o.user_id WHERE o.vehicle_id = $1 ORDER BY o.at DESC LIMIT 60`, [id]),
    ]);
    if (!compliance[id]) throw new HttpError(404, 'Không tìm thấy xe');
    return { ...compliance[id], docs, maintenanceLog: maintenance, odometer };
  });

  app.post('/api/ops/fleet/:id/docs', { preHandler: guard(...FLEET_EDIT) }, async (req) => {
    const b = z.object({ kind: z.enum(Object.keys(VEHICLE_DOC_KIND) as [string, ...string[]]), number: opt(100), issuedOn: date.nullish(), expiresOn: date, note: opt(500) }).parse(req.body);
    const id = vehicleParam(req.params);
    const row = await withTx(pool, (tx) => addVehicleDoc(tx, actorOf(req), id, b));
    await hub.publish({ type: 'vehicle', id });
    return row;
  });

  app.put('/api/ops/fleet/:id/plan', { preHandler: guard(...FLEET_EDIT) }, async (req) => {
    const b = z.object({ intervalKm: z.number().int().min(500).max(100000), intervalMonths: z.number().int().min(1).max(24) }).parse(req.body);
    const id = vehicleParam(req.params);
    await pool.query(`INSERT INTO ops_maintenance_plans(vehicle_id, interval_km, interval_months) VALUES ($1,$2,$3)
                      ON CONFLICT (vehicle_id) DO UPDATE SET interval_km = $2, interval_months = $3`, [id, b.intervalKm, b.intervalMonths]);
    return { ok: true };
  });

  app.post('/api/ops/fleet/:id/maintenance', { preHandler: guard(...FLEET_EDIT) }, async (req) => {
    const b = z.object({
      kind: z.enum(['dinh_ky', 'sua_chua', 'tai_nan']), doneOn: date, odometerKm: z.number().int().min(0).nullish(), supplierId: z.string().uuid().nullish(),
      work: z.string().trim().min(3).max(2000), cost: z.number().int().min(0).nullish(), outOfServiceHours: z.number().min(0).max(10000).nullish(),
    }).parse(req.body);
    return withTx(pool, (tx) => addMaintenance(tx, actorOf(req), vehicleParam(req.params), b));
  });

  app.post('/api/ops/fleet/:id/odometer', { preHandler: guard('crew', ...FLEET_EDIT) }, async (req) => {
    const b = z.object({ km: z.number().int().min(0).max(5_000_000), fuelLiters: z.number().min(0).max(500).nullish(), fuelCost: z.number().int().min(0).nullish(), note: opt(500) }).parse(req.body);
    const id = vehicleParam(req.params);
    await assertCrewVehicle(req, id);
    await withTx(pool, (tx) => recordOdometer(tx, actorOf(req), id, b));
    return { ok: true };
  });

  /** Dân số địa bàn phục vụ: mẫu số tỷ lệ ngừng tuần hoàn trên 100.000 dân trong báo cáo Utstein */
  app.put('/api/ops/settings/population', { preHandler: guard('admin', 'director') }, async (req) => {
    const b = z.object({ value: z.number().int().min(1000).max(200_000_000).nullable() }).parse(req.body);
    await pool.query(`INSERT INTO ops_settings(key, value, updated_by) VALUES ('population_served', $1, $2)
                      ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`, [JSON.stringify(b.value), req.user.id]);
    return { ok: true };
  });
}
