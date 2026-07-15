// app/api/catchup/route.js
// Rattrapage : va chercher dans le Message Storage de TTN les uplinks des
// dernieres 24 h et insere dans Supabase ceux qui manquent (sans doublon).
// Reprend la logique de votre catchup_ttn.js, mais tourne dans le cloud.
//
// Deux facons de le declencher :
//   - POST { password }  -> depuis la page admin (bouton manuel)
//   - GET  (cron)        -> Vercel Cron (header Authorization) ou
//                           un service externe via ?key=CRON_SECRET
//
// Variables d'environnement :
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   (deja presentes)
//   IMPORT_PASSWORD                      (deja presente : bouton manuel)
//   TTN_API_KEY                          (A AJOUTER : cle TTN lecture seule)
//   CRON_SECRET                          (A AJOUTER : secret du declenchement auto)

import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// DOIT correspondre a votre application TTN.
const TTN_REGION = 'nam1';
const TTN_APP_ID = 'weather-costa-rica';
const HOURS_BACK = 24;

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function runCatchup() {
  const since = new Date(Date.now() - HOURS_BACK * 3600 * 1000).toISOString();
  const url =
    `https://${TTN_REGION}.cloud.thethings.network/api/v3/as/applications/` +
    `${TTN_APP_ID}/packages/storage/uplink_message?after=${since}&limit=999`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.TTN_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`TTN ${resp.status} : ${detail.slice(0, 200)}`);
  }

  // TTN renvoie du NDJSON (1 objet JSON par ligne).
  const text = await resp.text();
  const lines = text.split('\n').filter((l) => l.trim());

  const rows = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const raw = obj.result || obj;
    const decoded = raw?.uplink_message?.decoded_payload;
    if (!decoded) continue;
    const rx = raw?.uplink_message?.rx_metadata?.[0] || {};
    rows.push({
      received_at:   raw.received_at || new Date().toISOString(),
      device_id:     raw?.end_device_ids?.device_id || 'unknown',
      temperature:   decoded.temperature ?? null,
      humidity:      decoded.humidity ?? null,
      pressure:      decoded.pressure ?? null,
      wind_speed:    decoded.wind_speed ?? null,
      solar:         decoded.solar ?? null,
      rain_today_mm: decoded.rain_today_mm ?? null,
      ir_scatter:    decoded.ir_scatter ?? null,
      weather:       decoded.weather ?? null,
      fog_detected:  decoded.fog_detected ? true : false,
      rssi:          rx.rssi ?? null,
      snr:           rx.snr ?? null,
      gateway:       rx?.gateway_ids?.gateway_id || null,
      f_cnt:         raw?.uplink_message?.f_cnt ?? null,
    });
  }

  if (rows.length === 0) return { received: 0, inserted: 0 };

  // Dedup via la contrainte unique : on ignore ce qui existe deja,
  // .select() ne renvoie que les lignes reellement inserees.
  const { data, error } = await supabase
    .from('readings')
    .upsert(rows, { onConflict: 'received_at,device_id,f_cnt', ignoreDuplicates: true })
    .select('id');

  if (error) throw error;
  return { received: rows.length, inserted: data ? data.length : 0 };
}

// --- Autorisation ---
function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${secret}` || key === secret;
}

// Declenchement automatique (Vercel Cron ou service externe).
export async function GET(req) {
  if (!cronAuthorized(req)) return json({ error: 'unauthorized' }, 401);
  try { return json({ ok: true, ...(await runCatchup()) }); }
  catch (e) { return json({ error: e.message }, 500); }
}

// Declenchement manuel depuis la page admin.
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  if (!process.env.IMPORT_PASSWORD || body.password !== process.env.IMPORT_PASSWORD) {
    return json({ error: 'Mot de passe incorrect' }, 401);
  }
  try { return json({ ok: true, ...(await runCatchup()) }); }
  catch (e) { return json({ error: e.message }, 500); }
}
