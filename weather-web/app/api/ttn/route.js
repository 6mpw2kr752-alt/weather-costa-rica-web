// =====================================================================
//  Webhook TTN -> Supabase   (Next.js App Router : app/api/ttn/route.js)
//
//  Recoit chaque uplink pousse par TTN (Integrations > Webhooks),
//  extrait le decoded_payload + metadata radio, et insere dans Supabase.
//  Meme logique de mapping que votre server.js / catchup_ttn.js.
//
//  Variables d'environnement (a saisir dans Vercel > Settings > Env Vars) :
//    SUPABASE_URL          = https://xxxx.supabase.co
//    SUPABASE_SERVICE_KEY  = cle "service_role" (JAMAIS cote navigateur)
//    TTN_WEBHOOK_SECRET     = un secret que vous choisissez
// =====================================================================

import { createClient } from '@supabase/supabase-js';

// Force l'execution cote serveur Node (pas edge, pas de cache).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // contourne RLS : ecriture autorisee
);

export async function POST(req) {
  // --- Verifie que la requete vient bien de VOTRE webhook TTN ---
  // Dans TTN, ajoutez un header additionnel :  X-Ttn-Secret: <votre secret>
  // puis mettez la meme valeur dans TTN_WEBHOOK_SECRET.
  const secret = req.headers.get('x-ttn-secret');
  if (process.env.TTN_WEBHOOK_SECRET && secret !== process.env.TTN_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const uplink = body?.uplink_message;
  const decoded = uplink?.decoded_payload;
  if (!decoded) {
    // Uplink sans payload decode (ex: join) -> on ignore proprement
    return new Response('No payload', { status: 200 });
  }

  const rx = uplink?.rx_metadata?.[0] || {};

  const reading = {
    received_at: body?.received_at || new Date().toISOString(),
    device_id: body?.end_device_ids?.device_id || 'unknown',
    temperature: decoded.temperature ?? null,
    humidity: decoded.humidity ?? null,
    pressure: decoded.pressure ?? null,
    wind_speed: decoded.wind_speed ?? null,
    solar: decoded.solar ?? null,
    rain_today_mm: decoded.rain_today_mm ?? null,
    ir_scatter: decoded.ir_scatter ?? null,
    weather: decoded.weather ?? null,
    fog_detected: !!decoded.fog_detected,
    rssi: rx.rssi ?? null,
    snr: rx.snr ?? null,
    gateway: rx?.gateway_ids?.gateway_id || null,
    f_cnt: uplink?.f_cnt ?? null,
  };

  // Deduplication via la contrainte unique (received_at, device_id, f_cnt).
  const { error } = await supabase
    .from('readings')
    .upsert(reading, {
      onConflict: 'received_at,device_id,f_cnt',
      ignoreDuplicates: true,
    });

  if (error) {
    console.error('[ttn-webhook] Supabase error:', error.message);
    return new Response('DB error', { status: 500 });
  }

  return new Response('OK', { status: 200 });
}

// Petit GET de test : ouvrir l'URL dans un navigateur doit repondre "TTN webhook up".
export async function GET() {
  return new Response('TTN webhook up', { status: 200 });
}
