import { many, one, type Queryable } from './db.js';

/**
 * Báo cáo: vận hành (thời gian đáp ứng theo mức ưu tiên, khối lượng, sử dụng xe), chuyên môn, chất lượng, tài chính.
 * Khoảng ngày tính theo giờ Việt Nam: từ 00:00 ngày `from` tới hết ngày `to`.
 */

export interface Range { from: string; to: string; stationId?: string | null }

/** Chỉ tiêu đáp ứng (phút, gọi tới lúc xe tới hiện trường) theo kế hoạch vận hành; dùng để tính tỉ lệ đạt */
export const RESPONSE_TARGET_MIN: Record<string, number> = { P1: 15, P2: 30, P3: 60, P4: 120 };
export const TARGETS = { handHygienePct: 80, satisfactionPct: 90, complaintOnTimePct: 95 };

const RANGE_CTE = `r AS (SELECT ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AS s, ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AS e)`;
// Ca thuộc điểm: có xe của điểm được giao
const STATION_FILTER = `($3::text IS NULL OR EXISTS (SELECT 1 FROM assignments a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.incident_id = i.id AND v.station_id = $3))`;
const args = (r: Range) => [r.from, r.to, r.stationId ?? null];

export const INTERVALS: [key: string, label: string, from: string, to: string][] = [
  ['answer', 'Đổ chuông → nhấc máy', 'T0', 'T1'],
  ['dispatch', 'Đổ chuông → giao xe', 'T0', 'T4'],
  ['turnout', 'Giao xe → xe lăn bánh', 'T4', 'T6'],
  ['response', 'Đổ chuông → tới hiện trường', 'T0', 'T7'],
  ['scene', 'Thời gian tại hiện trường', 'T7', 'T10'],
  ['transport', 'Rời hiện trường → tới bệnh viện', 'T10', 'T12'],
  ['handover', 'Tới bệnh viện → bàn giao xong', 'T12', 'T13'],
];

export async function operations(q: Queryable, r: Range) {
  const base = `WITH ${RANGE_CTE}, inc AS (SELECT i.* FROM incidents i, r WHERE i.created_at >= r.s AND i.created_at < r.e AND ${STATION_FILTER})`;
  const [totals, byPriority, byDay, byHour, intervals, fleet] = await Promise.all([
    one(q, `${base}
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM assignments a WHERE a.incident_id = inc.id))::int AS served,
             count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
             count(*) FILTER (WHERE status = 'advice_only')::int AS advice_only,
             count(*) FILTER (WHERE status = 'transferred_115')::int AS transferred_115,
             count(*) FILTER (WHERE source = '115')::int AS from_115,
             count(*) FILTER (WHERE final_priority IS NOT NULL AND suggested_priority IS NOT NULL AND final_priority <> suggested_priority)::int AS priority_overridden
        FROM inc`, args(r)),
    many(q, `${base} SELECT coalesce(final_priority, 'Chưa phân loại') AS priority, count(*)::int AS n FROM inc GROUP BY 1 ORDER BY 1`, args(r)),
    many(q, `${base}
      SELECT (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day, count(*)::int AS n,
             count(*) FILTER (WHERE final_priority = 'P1')::int AS p1, count(*) FILTER (WHERE final_priority = 'P2')::int AS p2
        FROM inc GROUP BY 1 ORDER BY 1`, args(r)),
    many(q, `${base} SELECT extract(hour FROM created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS hour, count(*)::int AS n FROM inc GROUP BY 1 ORDER BY 1`, args(r)),
    many(q, `${base}, t AS (
        SELECT inc.id, inc.final_priority AS p, ${INTERVALS.map(([k, , a, b]) =>
          `extract(epoch FROM (max(it.at) FILTER (WHERE it.code = '${b}') - min(it.at) FILTER (WHERE it.code = '${a}'))) / 60 AS ${k}`).join(', ')}
          FROM inc JOIN incident_times it ON it.incident_id = inc.id WHERE inc.final_priority IN ('P1','P2','P3','P4') GROUP BY inc.id, inc.final_priority)
      SELECT p AS priority, count(*)::int AS n,
             ${INTERVALS.map(([k]) => `round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${k}) FILTER (WHERE ${k} >= 0))::numeric, 1)::float AS ${k}_median,
             round((percentile_cont(0.9) WITHIN GROUP (ORDER BY ${k}) FILTER (WHERE ${k} >= 0))::numeric, 1)::float AS ${k}_p90,
             count(${k}) FILTER (WHERE ${k} >= 0)::int AS ${k}_n`).join(',\n             ')},
             count(*) FILTER (WHERE response <= CASE p WHEN 'P1' THEN ${RESPONSE_TARGET_MIN.P1} WHEN 'P2' THEN ${RESPONSE_TARGET_MIN.P2}
                                                     WHEN 'P3' THEN ${RESPONSE_TARGET_MIN.P3} ELSE ${RESPONSE_TARGET_MIN.P4} END)::int AS response_on_target
        FROM t GROUP BY p ORDER BY p`, args(r)),
    many(q, `WITH ${RANGE_CTE},
      log AS (SELECT l.vehicle_id, l.status, greatest(l.started_at, r.s) AS s, least(coalesce(l.ended_at, now()), r.e) AS e
                FROM vehicle_status_log l, r WHERE l.started_at < r.e AND coalesce(l.ended_at, now()) > r.s)
      SELECT v.id AS vehicle_id, v.type, v.station_id,
             round((coalesce(sum(extract(epoch FROM (log.e - log.s))) FILTER (WHERE log.status IN ('S1','S2')), 0) / 3600)::numeric, 1)::float AS available_h,
             round((coalesce(sum(extract(epoch FROM (log.e - log.s))) FILTER (WHERE log.status IN ('S3','S4','S5','S6','S7','S8')), 0) / 3600)::numeric, 1)::float AS busy_h,
             round((coalesce(sum(extract(epoch FROM (log.e - log.s))) FILTER (WHERE log.status = 'S9'), 0) / 3600)::numeric, 1)::float AS out_h,
             (SELECT count(*) FROM assignments a, r WHERE a.vehicle_id = v.id AND a.assigned_at >= r.s AND a.assigned_at < r.e)::int AS missions
        FROM vehicles v LEFT JOIN log ON log.vehicle_id = v.id
       WHERE ($3::text IS NULL OR v.station_id = $3)
       GROUP BY v.id ORDER BY v.id`, args(r)),
  ]);
  for (const f of fleet) f.utilization_pct = f.available_h + f.busy_h > 0 ? Math.round((1000 * f.busy_h) / (f.available_h + f.busy_h)) / 10 : null;
  return { totals, byPriority, byDay, byHour, intervals, fleet, targets: RESPONSE_TARGET_MIN, intervalLabels: INTERVALS.map(([k, l]) => ({ key: k, label: l })) };
}

export async function clinical(q: Queryable, r: Range) {
  const base = `WITH ${RANGE_CTE}, tr AS (
    SELECT t.* FROM transfers t JOIN vehicles v ON v.id = t.vehicle_id, r
     WHERE t.status = 'signed' AND t.signed_at >= r.s AND t.signed_at < r.e AND ($3::text IS NULL OR v.station_id = $3))`;
  const [totals, dispositions, diagnoses, hospitals, payers, procedures] = await Promise.all([
    one(q, `${base} SELECT count(*)::int AS signed,
                           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM transfer_amendments m WHERE m.transfer_id = tr.id))::int AS amended,
                           count(*) FILTER (WHERE (epcr->>'infectious')::boolean)::int AS infectious FROM tr`, args(r)),
    many(q, `${base} SELECT coalesce(epcr->'disposition'->>'type', 'chua_ghi') AS type, count(*)::int AS n FROM tr GROUP BY 1 ORDER BY 2 DESC`, args(r)),
    many(q, `${base} SELECT upper(coalesce(epcr->'diagnosis'->>'icd10', '')) AS icd10, coalesce(max(ic.name), max(epcr->'diagnosis'->>'text')) AS name, count(*)::int AS n
                      FROM tr LEFT JOIN icd10 ic ON ic.code = upper(tr.epcr->'diagnosis'->>'icd10')
                     WHERE coalesce(epcr->'diagnosis'->>'icd10', '') <> '' GROUP BY 1 ORDER BY 3 DESC LIMIT 15`, args(r)),
    many(q, `${base} SELECT epcr->'disposition'->>'hospital' AS hospital, count(*)::int AS n FROM tr
                     WHERE coalesce(epcr->'disposition'->>'hospital', '') <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, args(r)),
    many(q, `${base} SELECT coalesce(payer, 'chua_ghi') AS payer, count(*)::int AS n FROM tr GROUP BY 1 ORDER BY 2 DESC`, args(r)),
    many(q, `${base} SELECT x->>'name' AS name, count(*)::int AS n FROM tr, jsonb_array_elements(coalesce(tr.epcr->'medications', '[]'::jsonb)) x
                     WHERE coalesce(x->>'name', '') <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, args(r)),
  ]);
  return { totals, dispositions, diagnoses, hospitals, payers, medications: procedures };
}

export async function quality(q: Queryable, r: Range) {
  const p = args(r);
  const st = (col: string) => `($3::text IS NULL OR ${col} = $3)`;
  const [served, events, complaints, surveys, hygiene, disinfection, exposures, overrides] = await Promise.all([
    one(q, `WITH ${RANGE_CTE} SELECT count(DISTINCT i.id)::int AS n FROM incidents i JOIN assignments a ON a.incident_id = i.id, r
             WHERE i.created_at >= r.s AND i.created_at < r.e AND ${STATION_FILTER}`, p),
    many(q, `WITH ${RANGE_CTE} SELECT coalesce(severity, severity_reported) AS severity, count(*)::int AS n,
                    count(*) FILTER (WHERE status = 'dong')::int AS closed, count(*) FILTER (WHERE anonymous)::int AS anonymous
               FROM adverse_events e, r WHERE e.reported_at >= r.s AND e.reported_at < r.e AND ${st('e.station_id')} GROUP BY 1 ORDER BY 1`, p),
    one(q, `WITH ${RANGE_CTE} SELECT count(*)::int AS n,
                   count(*) FILTER (WHERE responded_at IS NOT NULL AND responded_at <= due_at)::int AS on_time,
                   count(*) FILTER (WHERE responded_at IS NULL AND due_at < now())::int AS overdue,
                   coalesce(jsonb_object_agg(category, c) FILTER (WHERE category IS NOT NULL), '{}') AS by_category
              FROM (SELECT c.*, count(*) OVER (PARTITION BY category) AS c FROM complaints c, r WHERE c.received_at >= r.s AND c.received_at < r.e) x`, [r.from, r.to]),
    one(q, `WITH ${RANGE_CTE} SELECT count(*)::int AS sent, count(answered_at)::int AS answered,
                   count(*) FILTER (WHERE overall >= 4)::int AS satisfied, round(avg(overall)::numeric, 2)::float AS avg_overall,
                   round(avg(timeliness)::numeric, 2)::float AS avg_timeliness, round(avg(attitude)::numeric, 2)::float AS avg_attitude, round(avg(care)::numeric, 2)::float AS avg_care
              FROM surveys s, r WHERE s.created_at >= r.s AND s.created_at < r.e`, [r.from, r.to]),
    one(q, `WITH ${RANGE_CTE} SELECT count(*)::int AS n, count(*) FILTER (WHERE compliant)::int AS compliant
              FROM hand_hygiene_obs h, r WHERE h.observed_at >= r.s AND h.observed_at < r.e AND ${st('h.station_id')}`, p),
    one(q, `WITH ${RANGE_CTE} SELECT count(*)::int AS n, count(*) FILTER (WHERE d.status = 'da_ky')::int AS signed,
                   count(*) FILTER (WHERE d.required_level <> 'thuong_quy')::int AS enhanced
              FROM disinfections d JOIN vehicles v ON v.id = d.vehicle_id, r WHERE d.created_at >= r.s AND d.created_at < r.e AND ${st('v.station_id')}`, p),
    one(q, `WITH ${RANGE_CTE} SELECT count(*)::int AS n FROM exposures x, r WHERE x.occurred_at >= r.s AND x.occurred_at < r.e`, [r.from, r.to]),
    one(q, `WITH ${RANGE_CTE} SELECT count(*)::int AS n FROM audit_events a, r WHERE a.at >= r.s AND a.at < r.e AND a.action IN ('assignment.created', 'assignment.auto') AND a.data ? 'equipmentOverride'`, [r.from, r.to]),
  ]);
  const eventTotal = events.reduce((s, e) => s + e.n, 0);
  return {
    served: served.n, events, eventTotal, eventsPer1000: served.n ? Math.round((eventTotal * 10000) / served.n) / 10 : null,
    complaints, surveys, hygiene, disinfection, exposures: exposures.n, equipmentOverrides: overrides.n, targets: TARGETS,
  };
}

export async function financial(q: Queryable, r: Range) {
  const p = args(r);
  const [monthly, byVehicle, byStation, byPayer, byCategory] = await Promise.all([
    many(q, `WITH m AS (SELECT to_char(d, 'YYYY-MM') AS month FROM generate_series(date_trunc('month', $1::date), $2::date, interval '1 month') d)
      SELECT m.month,
             (SELECT coalesce(sum(total - waived), 0) FROM charges c WHERE c.status NOT IN ('huy', 'thieu_thong_tin') AND to_char(c.service_date, 'YYYY-MM') = m.month
                AND c.service_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR c.station_id = $3))::float AS revenue,
             (SELECT coalesce(sum(p.amount), 0) FROM payments p JOIN charges c ON c.id = p.charge_id WHERE NOT p.voided
                AND to_char(p.received_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') = m.month
                AND (p.received_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2 AND ($3::text IS NULL OR c.station_id = $3))::float AS collected,
             (SELECT coalesce(sum(amount), 0) FROM expenses e WHERE to_char(e.spent_on, 'YYYY-MM') = m.month AND e.spent_on BETWEEN $1 AND $2
                AND ($3::text IS NULL OR e.station_id = $3))::float AS expenses
        FROM m ORDER BY m.month`, p),
    many(q, `SELECT v.id AS vehicle_id, v.type, v.station_id,
             (SELECT count(*) FROM charges c WHERE c.vehicle_id = v.id AND c.status <> 'huy' AND c.service_date BETWEEN $1 AND $2)::int AS trips,
             (SELECT coalesce(sum(total - waived), 0) FROM charges c WHERE c.vehicle_id = v.id AND c.status NOT IN ('huy', 'thieu_thong_tin') AND c.service_date BETWEEN $1 AND $2)::float AS revenue,
             (SELECT coalesce(sum(amount), 0) FROM expenses e WHERE e.vehicle_id = v.id AND e.spent_on BETWEEN $1 AND $2)::float AS expenses
        FROM vehicles v WHERE ($3::text IS NULL OR v.station_id = $3) ORDER BY v.id`, p),
    many(q, `SELECT s.id AS station_id, s.name,
             (SELECT coalesce(sum(total - waived), 0) FROM charges c WHERE c.station_id = s.id AND c.status NOT IN ('huy', 'thieu_thong_tin') AND c.service_date BETWEEN $1 AND $2)::float AS revenue,
             (SELECT coalesce(sum(amount), 0) FROM expenses e WHERE (e.station_id = s.id OR e.vehicle_id IN (SELECT id FROM vehicles WHERE station_id = s.id)) AND e.spent_on BETWEEN $1 AND $2)::float AS expenses
        FROM stations s WHERE ($3::text IS NULL OR s.id = $3) ORDER BY s.id`, p),
    many(q, `SELECT payer_kind, count(*)::int AS n, coalesce(sum(total), 0)::float AS total, coalesce(sum(waived), 0)::float AS waived, coalesce(sum(paid), 0)::float AS paid
               FROM charges WHERE status <> 'huy' AND service_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR station_id = $3) GROUP BY 1 ORDER BY 3 DESC`, p),
    many(q, `SELECT category, count(*)::int AS n, sum(amount)::float AS amount FROM expenses
               WHERE spent_on BETWEEN $1 AND $2 AND ($3::text IS NULL OR station_id = $3) GROUP BY 1 ORDER BY 3 DESC`, p),
  ]);
  for (const v of byVehicle) { v.margin = v.revenue - v.expenses; v.per_trip = v.trips ? Math.round(v.revenue / v.trips) : 0; }
  for (const s of byStation) s.margin = s.revenue - s.expenses;
  const sum = (k: string) => monthly.reduce((s, m) => s + m[k], 0);
  return { monthly, byVehicle, byStation, byPayer, byCategory, totals: { revenue: sum('revenue'), collected: sum('collected'), expenses: sum('expenses'), margin: sum('revenue') - sum('expenses') } };
}
