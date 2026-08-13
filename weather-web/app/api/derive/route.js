// =====================================================================
//  app/api/derive/route.js
//
//  Grandeurs derivees - methode de la section 3 du rapport.
//
//    1. Position solaire            Spencer (1971)
//    2. Irradiance de ciel clair    Ineichen & Perez (2006)
//    3. Indice de clarte            Kt = GHI_mesure / GHI_ciel_clair
//    4. Nebulosite en oktas         Kasten & Czeplak (1980)
//    5. Drapeau d'immersion         retrodiffusion IR elevee
//
//  Calcul cote serveur : l'heure UTC vient de `received_at` fourni par TTN,
//  ce qui evite d'installer une horloge temps reel sur la carte.
//
//  Declenchement :
//    GET  Authorization: Bearer <CRON_SECRET>     (Vercel Cron)
//    GET  ?key=<CRON_SECRET>                      (manuel)
//    GET  ?key=<CRON_SECRET>&days=60              (recalcul historique)
//
//  vercel.json :
//    { "path": "/api/derive", "schedule": "*/15 * * * *" }
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
//  SITE
// ---------------------------------------------------------------------
const LAT = 9.48;
const LON = -83.59;
const LINKE = 3.5;          // trouble de Linke, tropical humide

// ---------------------------------------------------------------------
//  IMMERSION  -  seuils mesures sur site, nuit du 3 aout 2026
//
//  Configuration capteur de reference :
//     PS_CONF12  = 0x0808   (PS_IT = 8T, sortie 16 bits)
//     PS_CONF3MS = 0x0360   (4 multi-pulses, LED 200 mA)
//
//  Series de 60 lectures a ALS = 0 (obscurite complete) :
//     air clair              prox = 13.6   (ecart-type 0.7)
//     brouillard             prox = 16.7   (+23 %)
//     brouillard plus dense  prox = 19.7   (+45 %)
//
//  L'ecart (3 a 6 counts) sort nettement du bruit (+/- 0.7).
//
//  TOUT CHANGEMENT DE PS_CONF12 OU PS_CONF3MS INVALIDE CES SEUILS :
//  la campagne de mesure serait a refaire.
// ---------------------------------------------------------------------
const IMMERSION_EXCESS_PCT = 25;    // hausse minimale sur la ligne de base
const DENSE_EXCESS_PCT     = 40;

// Domaine de validite du canal proximite.
//
// Au-dela de ~32 500 counts d'ALS, le rayonnement solaire IR direct sature
// l'etage d'entree : PS_SPFLAG se leve et prox est renvoye a 0. Mais bien
// avant la saturation, la lumiere ambiante influence deja la mesure : les
// series du 3 aout donnent prox = 54 a ALS = 770 et prox = 29 a ALS = 86,
// sans rapport avec l'epaisseur du brouillard. Le critere n'est donc
// applique qu'en faible luminosite, ce qui recoupe la condition
// "irradiance < 100 W/m2" de la section 3 du rapport.
const ALS_MAX_FOR_IR   = 100;
const SOLAR_MAX_FOR_IR = 100;       // W/m2

// Ligne de base IR : percentile bas sur fenetre CENTREE.
// Centree = on regarde avant ET apres. Impossible a bord, trivial ici, et
// plus robuste : un episode long n'entraine pas la reference avec lui.
const BASELINE_WINDOW_H = 48;
const BASELINE_QUANTILE = 0.10;
const BASELINE_MIN_N    = 8;

const MIN_ELEVATION_DEG = 10;       // sous cet angle, Kt n'a pas de sens

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// =====================================================================
//  1. Position solaire  -  Spencer (1971)
// =====================================================================
function solarPosition(date) {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const doy = Math.floor((date.getTime() - yearStart) / 86400000) + 1;
  const sod =
    date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();

  const g = (2 * Math.PI * (doy - 1)) / 365;

  const decl =
    0.006918 -
    0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) + 0.001480 * Math.sin(3 * g);

  const eot =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) - 0.040890 * Math.sin(2 * g));

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
//
//  L'altitude est deduite de la pression mesuree plutot que codee en dur :
//  la station a ete deplacee entre Jilguero et Montana, et une altitude
//  figee fausserait le modele apres chaque deplacement.
// =====================================================================
function altitudeFromPressure(hPa) {
  if (!hPa || hPa < 500 || hPa > 1100) return 1650;   // repli
  return (1 - Math.pow(hPa / 1013.25, 1 / 5.25588)) / 2.25577e-5;
}

function clearSkyGHI(elevation, doy, pressureHpa, alt) {
  if (elevation <= 0) return 0;

  const zenith = 90 - elevation;
  const cosZ = Math.cos(zenith * DEG);
  if (cosZ <= 0) return 0;

  let am = 1 / (cosZ + 0.50572 * Math.pow(96.07995 - zenith, -1.6364));
  am *= (pressureHpa || 1013.25) / 1013.25;

  const fh1 = Math.exp(-alt / 8000);
  const fh2 = Math.exp(-alt / 1250);
  const cg1 = 5.09e-5 * alt + 0.868;
  const cg2 = 3.92e-5 * alt + 0.0387;

  const i0 = 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365));

  return Math.max(
    0,
    cg1 * i0 * cosZ *
      Math.exp(-cg2 * am * (fh1 + fh2 * (LINKE - 1))) *
      Math.exp(0.01 * Math.pow(am, 1.8))
  );
}

// =====================================================================
//  3. Kt -> oktas  -  Kasten & Czeplak (1980)
//
//     G/Gclear = 1 - 0.75 * (N/8)^3.4  =>  N = 8 * ((1-Kt)/0.75)^(1/3.4)
//
//  Cette relation donne 5.4 oktas a Kt = 0.80, la ou la section 3 du
//  rapport annonce 0 okta au-dessus de 0.80 : les deux sont incompatibles.
//  On applique K&C, ce qui rend la citation exacte ; les trois bornes
//  citees dans le rapport sont a corriger en consequence.
// =====================================================================
function ktToOktas(kt) {
  if (kt >= 1) return 0;
  const r = Math.min(1, Math.max(0, (1 - kt) / 0.75));
  return Math.round(Math.min(8, 8 * Math.pow(r, 1 / 3.4)));
}

// =====================================================================
//  4. Ligne de base IR
// =====================================================================
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// Une mesure ne contribue a la ligne de base que si elle est comparable :
// canal non sature et faible luminosite ambiante.
function usableForIR(row) {
  if (row.ir_scatter === null || row.ir_scatter === undefined) return false;
  if (row.ir_saturated === true) return false;
  if (row.als_raw !== null && row.als_raw !== undefined && row.als_raw > ALS_MAX_FOR_IR) {
    return false;
  }
  if (row.solar !== null && row.solar !== undefined && row.solar > SOLAR_MAX_FOR_IR) {
    return false;
  }
  return true;
}

function computeBaselines(rows) {
  const half = (BASELINE_WINDOW_H / 2) * 3600 * 1000;
  const times = rows.map((r) => new Date(r.received_at).getTime());
  const ok = rows.map(usableForIR);

  return rows.map((row, i) => {
    if (!ok[i]) return null;
    const win = [];
    for (let j = 0; j < rows.length; j++) {
      if (ok[j] && Math.abs(times[j] - times[i]) <= half) win.push(rows[j].ir_scatter);
    }
    if (win.length < BASELINE_MIN_N) return null;
    win.sort((a, b) => a - b);
    return quantile(win, BASELINE_QUANTILE);
  });
}

// =====================================================================
//  4 bis. PLUIE JOURNALIERE, par difference de cumuls
//
//  La station transmet desormais le CUMUL du pluviometre depuis sa mise en
//  service, et non son compteur "today". Ce compteur se remettait a zero
//  selon l'horloge interne du capteur, de fuseau inconnu, ce qui effacait
//  en pleine journee locale la pluie deja tombee.
//
//  La pluie d'une journee locale est donc la difference entre le dernier et
//  le premier cumul de cette journee. Deux precautions :
//    - une difference negative signale un debordement du compteur 16 bits
//      (6553.5 mm) ou un remplacement du capteur : on la neutralise ;
//    - la journee est celle du Costa Rica (UTC-6), pas celle du capteur.
// =====================================================================
function crDayKey(iso) {
  const t = new Date(iso);
  t.setUTCHours(t.getUTCHours() - 6);
  return t.toISOString().split('T')[0];
}

function computeDailyRain(rows) {
  // Premier cumul observe pour chaque journee locale.
  const firstOfDay = new Map();
  for (const r of rows) {
    if (r.rain_today_mm === null || r.rain_today_mm === undefined) continue;
    const day = crDayKey(r.received_at);
    if (!firstOfDay.has(day)) firstOfDay.set(day, Number(r.rain_today_mm));
  }

  return rows.map((r) => {
    if (r.rain_today_mm === null || r.rain_today_mm === undefined) return null;
    const base = firstOfDay.get(crDayKey(r.received_at));
    if (base === undefined) return null;
    const d = Number(r.rain_today_mm) - base;
    return d < 0 ? 0 : Math.round(d * 10) / 10;   // debordement ou capteur remplace
  });
}

async function runDerive(days) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from('readings')
    .select('received_at, device_id, f_cnt, pressure, solar, ir_scatter, ir_saturated, als_raw, rain_today_mm')
    .gte('received_at', since)
    .order('received_at', { ascending: true })
    .limit(10000);

  if (error) throw new Error('lecture Supabase : ' + error.message);
  if (!rows || rows.length === 0) return { processed: 0, immersions: 0, days };

  const baselines  = computeBaselines(rows);
  const dailyRain  = computeDailyRain(rows);
  const now = new Date().toISOString();

  let immersions = 0, denses = 0, indetermines = 0;

  const updates = rows.map((row, i) => {
    const date = new Date(row.received_at);
    const { doy, elevation } = solarPosition(date);
    const alt = altitudeFromPressure(row.pressure);

    const isDay = elevation > MIN_ELEVATION_DEG;
    const ghiCs = isDay ? clearSkyGHI(elevation, doy, row.pressure, alt) : 0;

    let kt = null, oktas = null;
    if (isDay && ghiCs > 1 && row.solar !== null && row.solar !== undefined) {
      kt = Math.min(1.2, Math.max(0, row.solar / ghiCs));
      oktas = ktToOktas(kt);
    }

    // ---- Immersion -------------------------------------------------
    const baseline = baselines[i];
    let excessPct = null, immersion = null, dense = null;

    if (baseline !== null && baseline > 0 && usableForIR(row)) {
      excessPct = (100 * (row.ir_scatter - baseline)) / baseline;
      immersion = excessPct >= IMMERSION_EXCESS_PCT;
      dense = excessPct >= DENSE_EXCESS_PCT;
      if (immersion) immersions++;
      if (dense) denses++;
    } else {
      // null, et non false : "indeterminable" n'est pas "pas d'immersion".
      // Confondre les deux fausserait toute statistique ulterieure, et en
      // particulier la table de contingence (POD, FAR, CSI).
      indetermines++;
    }

    return {
      received_at: row.received_at,
      device_id: row.device_id,
      f_cnt: row.f_cnt,
      solar_elevation: Math.round(elevation * 100) / 100,
      ghi_clearsky: Math.round(ghiCs * 10) / 10,
      kt: kt === null ? null : Math.round(kt * 1000) / 1000,
      oktas,
      immersion,
      immersion_dense: dense,
      prox_baseline: baseline === null ? null : Math.round(baseline * 10) / 10,
      prox_excess: excessPct === null ? null : Math.round(excessPct * 10) / 10,
      altitude_est: Math.round(alt),
      rain_day_mm: dailyRain[i],
      derived_at: now,
    };
  });

  for (let i = 0; i < updates.length; i += 500) {
    const { error: upErr } = await supabase
      .from('readings')
      .upsert(updates.slice(i, i + 500), { onConflict: 'received_at,device_id,f_cnt' });
    if (upErr) throw new Error('ecriture Supabase : ' + upErr.message);
  }

  return { processed: updates.length, immersions, denses, indetermines, days };
}

// =====================================================================
export async function GET(req) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  const auth = req.headers.get('authorization');

  const ok =
    process.env.CRON_SECRET &&
    (auth === `Bearer ${process.env.CRON_SECRET}` || key === process.env.CRON_SECRET);

  if (!ok) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 3));

  try {
    const result = await runDerive(days);
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[derive]', e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
