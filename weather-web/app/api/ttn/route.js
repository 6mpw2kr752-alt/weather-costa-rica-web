// =====================================================================
//  Webhook TTN -> Supabase   (Next.js App Router : app/api/ttn/route.js)
//
//  Remplace ton fichier actuel. Une seule chose change : on stocke aussi
//  les octets bruts (frm_payload) en plus du payload decode par TTN.
//
//  Variables d'environnement (inchangees) :
//    SUPABASE_URL, SUPABASE_SERVICE_KEY, TTN_WEBHOOK_SECRET
// =====================================================================

import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export async function POST(req) {
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

  // --- Octets bruts, AVANT toute consideration sur le decodage ------------
  //
  // TTN les fournit systematiquement, decodeur ou pas. C'est la seule chose
  // dans ce webhook qui ne peut jamais devenir fausse : ce sont exactement
  // les octets emis par la station.
  //
  // Sans eux, une erreur dans le decodeur TTN detruit definitivement la
  // donnee. Avec eux, elle se corrige et se rejoue.
  const frmPayload = uplink?.frm_payload ?? null;

  const decoded = uplink?.decoded_payload;

  // Changement de comportement : on enregistre meme si TTN n'a pas su
  // decoder, du moment qu'il y a des octets. Auparavant ces uplinks etaient
  // perdus. Ce sont precisement ceux qu'on veut garder : ils signalent que
  // le decodeur a un probleme.
  if (!decoded && !frmPayload) {
    return new Response('No payload', { status: 200 });
  }

  const rx = uplink?.rx_metadata?.[0] || {};

  const reading = {
    received_at:   body?.received_at || new Date().toISOString(),
    device_id:     body?.end_device_ids?.device_id || 'unknown',
    frm_payload:   frmPayload,
    temperature:   decoded?.temperature ?? null,
    humidity:      decoded?.humidity ?? null,
    pressure:      decoded?.pressure ?? null,
    wind_speed:    decoded?.wind_speed ?? null,
    solar:         decoded?.solar ?? null,
    rain_today_mm: decoded?.rain_today_mm ?? null,
ir_scatter:    decoded?.ir_scatter ?? null,
    als:           decoded?.als ?? null,
    ir_saturated:  decoded?.ir_saturated ?? null,
    weather:       decoded?.weather ?? null,
    fog_detected:  !!decoded?.fog_detected,
    rssi:          rx.rssi ?? null,
    snr:           rx.snr ?? null,
    gateway:       rx?.gateway_ids?.gateway_id || null,
    f_cnt:         uplink?.f_cnt ?? null,
  };

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

export async function GET() {
  return new Response('TTN webhook up', { status: 200 });
}

// =====================================================================
//  A FAIRE AUSSI dans app/api/catchup/route.js
//
//  Meme ajout, sinon les mesures rattrapees par le cron de 7h n'auront
//  pas leurs octets bruts. Dans la construction de l'objet, ajouter :
//
//      frm_payload: raw?.uplink_message?.frm_payload ?? null,
//
//  juste apres la ligne `device_id: ...`.
// =====================================================================
