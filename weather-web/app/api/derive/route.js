// =====================================================================
//  app/api/derive/route.js
//
//  Calcul des grandeurs derivees - methode de la section 3 du rapport.
//
//    1. Position solaire            Spencer (1971)
//    2. Irradiance de ciel clair    Ineichen & Perez (2006)
//    3. Indice de clarte            Kt = GHI_mesure / GHI_ciel_clair
//    4. Nebulosite en oktas         Kasten & Czeplak (1980)
//    5. Drapeau d'immersion         IR eleve + irradiance faible
//
//  Tourne cote serveur, comme /api/catchup. L'heure UTC vient du champ
//  `received_at` fourni par TTN : c'est ce qui evite d'avoir a installer
//  une horloge temps reel sur la carte.
//
//  Declenchement :
//    - GET  avec Authorization: Bearer <CRON_SECRET>   (Vercel Cron)
//    - GET  ?key=<CRON_SECRET>                          (declenchement manuel)
//    - GET  ?key=<CRON_SECRET>&days=60                  (recalcul historique)
//
//  Ajouter dans vercel.json, a cote du cron existant :
//      { "path": "/api/derive", "schedule": "*/15 * * * *" }
//
//  Variables d'environnement : SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET
// =====================================================================

import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------------------------------------------------------------------
//  PARAMETRES DU SITE
//  A ajuster avec le GPS du point d'installation reel.
// ---------------------------------------------------------------------
const LAT = 9.48;        // Nord positif
const LON = -83.59;      // Est positif, donc Ouest negatif
const ALT = 1650;        // metres
const LINKE = 3.5;       // trouble de Linke, tropical humide (rapport, §3)

// ---------------------------------------------------------------------
//  SEUILS
// ---------------------------------------------------------------------

// Exces IR requis pour signaler l'immersion.
//
// Le rapport ecrit ">200 counts". La mesure de banc donne une ligne de base
// de 2520 counts : un seuil ABSOLU a 200 serait franchi en permanence. Les
// 200 sont donc comptes AU-DESSUS de la ligne de base.
//
// A CALIBRER sur le terrain : trace l'histogramme de prox_excess et compare
// au journal d'observation visuelle.
const PROX_EXCESS_COUNTS = 200;

// Irradiance sous laquelle l'immersion peut etre signalee (rapport, §3).
// Consequence assumee : le critere ne peut pas se declencher de nuit.
const IMMERSION_GHI_MAX = 100;

// Elevation solaire minimale pour que Kt ait un sens : en dessous, le
// denominateur tend vers zero et le rapport explose.
const MIN_ELEVATION_DEG = 10;

// Ligne de base IR : percentile bas sur une fenetre CENTREE.
// Fenetre centree = on regarde avant ET apres. Impossible a bord, trivial
// ici, et nettement plus robuste : un episode long n'entraine pas la
// reference avec lui.
const BASELINE_WINDOW_H = 24;
const BASELINE_QUANTILE = 0.05;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// =====================================================================
//  1. Position solaire  -  Spencer (1971)
// =====================================================================
function solarPosition(date) {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const doy = Math.floor((date.getTime() - yearStart) / 86400000) + 1;
  const sod =
    date.getUTCHours() * 3600 +
    date.getUTCMinutes() * 60 +
    date.getUTCSeconds();

  const g = (2 * Math.PI * (doy - 1)) / 365;

  // Declinaison, radians
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) + 0.001480 * Math.sin(3 * g);

  // Equation du temps, minutes
  const eot =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) - 0.040890 * Math.sin(2 * g));

  // Temps solaire vrai puis angle horaire
  const tst = sod / 60 + 4 * LON + eot;
  const omega = (tst / 4 - 180) * DEG;

  const phi = LAT * DEG;
  let cosZ =
    Math.sin(phi) * Math.sin(decl) +
    Math.cos(phi) * Math.cos(decl) * Math.cos(omega);
  cosZ = Math.max(-1, Math.min(1, cosZ));

  return { doy, elevation: 90 - Math.acos(cosZ) * RAD };
}

// =====================================================================
//  2. Ciel clair  -  Ineichen & Perez (2006)
//     Masse d'air Kasten & Young (1989), corrigee de la pression mesuree.
// =====================================================================
function clearSkyGHI(elevation, doy, pressureHpa) {
  if (elevation <= 0) return 0;

  const zenith = 90 - elevation;
  const cosZ = Math.cos(zenith * DEG);
  if (cosZ <= 0) return 0;

  let am = 1 / (cosZ + 0.50572 * Math.pow(96.07995 - zenith, -1.6364));
  am *= (pressureHpa || 1013.25) / 1013.25;   // masse d'air absolue

  const fh1 = Math.exp(-ALT / 8000);
  const fh2 = Math.exp(-ALT / 1250);
  const cg1 = 5.09e-5 * ALT + 0.868;
  const cg2 = 3.92e-5 * ALT + 0.0387;

  const i0 = 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365));

  const ghi =
    cg1 * i0 * cosZ *
    Math.exp(-cg2 * am * (fh1 + fh2 * (LINKE - 1))) *
    Math.exp(0.01 * Math.pow(am, 1.8));

  return Math.max(0, ghi);
}

// =====================================================================
//  3. Kt -> oktas  -  Kasten & Czeplak (1980)
//
//     G/Gclear = 1 - 0.75 * (N/8)^3.4   =>   N = 8 * ((1-Kt)/0.75)^(1/3.4)
//
//     Note : cette relation donne 5.4 oktas a Kt = 0.80, alors que la
//     section 3 du rapport annonce 0 okta au-dessus de 0.80. Les deux sont
//     incompatibles. On applique ici la formule de K&C, ce qui rend la
//     citation exacte ; il faut alors ajuster les trois bornes citees dans
//     le rapport, ou retirer l'attribution a K&C.
// =====================================================================
function ktToOktas(kt) {
  if (kt >= 1) return 0;
  const r = Math.min(1, Math.max(0, (1 - kt) / 0.75));
  return Math.round(Math.min(8, 8 * Math.pow(r, 1 / 3.4)));
}

// =====================================================================
//  4. Ligne de base IR  -  percentile bas sur fenetre centree
// =====================================================================
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function computeBaselines(rows) {
  const halfWindow = (BASELINE_WINDOW_H / 2) * 3600 * 1000;
  const times = rows.map((r) => new Date(r.received_at).getTime());

  return rows.map((row, i) => {
    if (row.ir_scatter == null) return null;

    const window = [];
    for (let j = 0; j < rows.length; j++) {
      if (Math.abs(times[j] - times[i]) <= halfWindow &&
          rows[j].ir_scatter != null) {
        window.push(rows[j].ir_scatter);
      }
    }
    if (window.length < 12) return null;   // moins d'1 h : pas fiable
    window.sort((a, b) => a - b);
    return quantile(window, BASELINE_QUANTILE);
  });
}

// =====================================================================
//  Traitement
// =====================================================================
async function runDerive(days) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from('readings')
    .select('received_at, device_id, f_cnt, pressure, solar, ir_scatter')
    .gte('received_at', since)
    .order('received_at', { ascending: true })
    .limit(10000);

  if (error) throw new Error('lecture Supabase : ' + error.message);
  if (!rows || rows.length === 0) return { processed: 0, immersions: 0 };

  const baselines = computeBaselines(rows);
  const now = new Date().toISOString();

  let immersions = 0;
  const updates = rows.map((row, i) => {
    const date = new Date(row.received_at);
    const { doy, elevation } = solarPosition(date);

    const isDay = elevation > MIN_ELEVATION_DEG;
    const ghiCs = isDay ? clearSkyGHI(elevation, doy, row.pressure) : 0;

    let kt = null;
    let oktas = null;
    if (isDay && ghiCs > 1 && row.solar != null) {
      kt = Math.min(1.2, Math.max(0, row.solar / ghiCs));
      oktas = ktToOktas(kt);
    }

    const baseline = baselines[i];
    let excess = null;
    let immersion = false;
    if (baseline != null && row.ir_scatter != null) {
      excess = row.ir_scatter - baseline;
      // Critere du rapport : retrodiffusion IR elevee ET irradiance faible.
      immersion =
        excess > PROX_EXCESS_COUNTS &&
        row.solar != null &&
        row.solar < IMMERSION_GHI_MAX;
    }
    if (immersion) immersions++;

    return {
      received_at: row.received_at,
      device_id: row.device_id,
      f_cnt: row.f_cnt,
      solar_elevation: Math.round(elevation * 100) / 100,
      ghi_clearsky: Math.round(ghiCs * 10) / 10,
      kt: kt == null ? null : Math.round(kt * 1000) / 1000,
      oktas,
      immersion,
      prox_baseline: baseline == null ? null : Math.round(baseline * 10) / 10,
      prox_excess: excess == null ? null : Math.round(excess * 10) / 10,
      derived_at: now,
    };
  });

  // Ecriture par lots : upsert sur la contrainte unique existante.
  for (let i = 0; i < updates.length; i += 500) {
    const batch = updates.slice(i, i + 500);
    const { error: upErr } = await supabase
      .from('readings')
      .upsert(batch, { onConflict: 'received_at,device_id,f_cnt' });
    if (upErr) throw new Error('ecriture Supabase : ' + upErr.message);
  }

  return { processed: updates.length, immersions, days };
}

// =====================================================================
export async function GET(req) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  const auth = req.headers.get('authorization');

  const ok =
    (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) ||
    (process.env.CRON_SECRET && key === process.env.CRON_SECRET);

  if (!ok) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // days=N pour recalculer l'historique apres un changement de seuil.
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 3));

  try {
    const result = await runDerive(days);
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[derive]', e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
