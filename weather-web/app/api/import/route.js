// app/api/import/route.js
// Import protege par mot de passe des mesures stockees sur la carte STM32.
//
// Recoit le dump CSV du firmware (colonnes :
//   idx,uptime_s,T_C,H_pct,P_hPa,V_ms,Sol_Wm2,R_mm,IR,WX,TX_OK)
// datate chaque mesure a partir de l'heure de la DERNIERE mesure (refTime),
// en reculant de 15 min par ligne, puis n'insere que ce qui est PLUS RECENT
// que la derniere mesure deja en base (pas de superposition).
//
// Variables d'environnement (Vercel > Settings > Environment Variables) :
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  (deja presentes)
//   IMPORT_PASSWORD                     (a AJOUTER : le mot de passe d'import)

import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------------------------------------------------------------------
//  A CONFIRMER : correspondance code meteo STM32 (WX) -> texte dashboard.
//  D'apres vos donnees, WX augmente avec l'humidite. Ajustez si besoin.
// ---------------------------------------------------------------------
const WX_MAP = { 0: 'clear', 1: 'humid', 2: 'mist', 3: 'fog', 4: 'dense_fog' };

const STEP_MS = 15 * 60 * 1000; // 15 minutes entre deux mesures

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Parse le dump : ne garde que les lignes de donnees valides.
function parseDump(csv) {
  const rows = [];
  for (const raw of String(csv).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/^\d+\s*,/.test(line)) continue;          // ignore entetes/pied/texte
    const p = line.split(',').map((s) => s.trim());
    if (p.length < 11) continue;

    const humidity = Number(p[3]);
    const pressure = Number(p[4]);
    // filtre anti-corruption / lignes de demarrage (H>100 ou pression absurde)
    if (!isFinite(humidity) || humidity > 100) continue;
    if (!isFinite(pressure) || pressure < 300) continue;

    rows.push({
      temperature:   Number(p[2]),
      humidity,
      pressure,
      wind_speed:    Number(p[5]),
      solar:         Number(p[6]),
      rain_today_mm: Number(p[7]),
      ir_scatter:    Number(p[8]),
      wx:            Number(p[9]),
    });
  }
  return rows;
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON invalide' }, 400); }

  const { password, csv, refTime, deviceId, dryRun } = body;

  // --- Securite : mot de passe ---
  if (!process.env.IMPORT_PASSWORD || password !== process.env.IMPORT_PASSWORD) {
    return json({ error: 'Mot de passe incorrect' }, 401);
  }
  if (!csv || !refTime) return json({ error: 'csv et refTime requis' }, 400);

  const ref = new Date(refTime);
  if (isNaN(ref.getTime())) return json({ error: 'Heure de reference invalide' }, 400);

  const device = deviceId || 'stm32-costar';
  const rows = parseDump(csv);
  if (rows.length === 0) return json({ error: 'Aucune ligne valide dans le dump' }, 400);

  // Horodatage : derniere ligne = refTime, puis 15 min en arriere pour les precedentes.
  const N = rows.length;
  const readings = rows.map((r, i) => {
    const ts = new Date(ref.getTime() - (N - 1 - i) * STEP_MS);
    const weather = WX_MAP[r.wx] ?? null;
    return {
      received_at:   ts.toISOString(),
      device_id:     device,
      temperature:   r.temperature,
      humidity:      r.humidity,
      pressure:      r.pressure,
      wind_speed:    r.wind_speed,
      solar:         r.solar,
      rain_today_mm: r.rain_today_mm,
      ir_scatter:    r.ir_scatter,
      weather,
      fog_detected:  weather === 'fog' || weather === 'dense_fog',
      rssi: null, snr: null, gateway: null, f_cnt: null,
    };
  });

  // Derniere mesure deja en base pour ce device.
  const { data: latest, error: e1 } = await supabase
    .from('readings')
    .select('received_at')
    .eq('device_id', device)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (e1) return json({ error: e1.message }, 500);

  const latestTs = latest ? new Date(latest.received_at).getTime() : 0;

  // On ne garde que ce qui est PLUS RECENT que la derniere mesure en base.
  const toInsert = readings.filter((r) => new Date(r.received_at).getTime() > latestTs);

  const summary = {
    totalParsed:    N,
    latestExisting: latest ? latest.received_at : null,
    newCount:       toInsert.length,
    firstNew:       toInsert[0]?.received_at || null,
    lastNew:        toInsert[toInsert.length - 1]?.received_at || null,
  };

  // Mode apercu : on calcule sans rien inserer.
  if (dryRun) return json({ ok: true, dryRun: true, ...summary });

  if (toInsert.length === 0) return json({ ok: true, inserted: 0, ...summary });

  const { error: e2 } = await supabase.from('readings').insert(toInsert);
  if (e2) return json({ error: e2.message }, 500);

  return json({ ok: true, inserted: toInsert.length, ...summary });
}
