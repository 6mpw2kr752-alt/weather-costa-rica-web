// app/api/delete/route.js
// Suppression de mesures sur une plage [from, to], protegee par mot de passe.
//
// ATTENTION : la suppression est IRREVERSIBLE.
// Deux protections cote serveur :
//   1) mot de passe (meme variable que l'import : IMPORT_PASSWORD)
//   2) sans "confirm: true", la route ne fait qu'un APERCU (compte + periode),
//      elle ne supprime rien.
//
// Variables d'environnement : SUPABASE_URL, SUPABASE_SERVICE_KEY, IMPORT_PASSWORD

import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON invalide' }, 400); }

  const { password, from, to, deviceId, confirm } = body;

  // --- Securite : mot de passe ---
  if (!process.env.IMPORT_PASSWORD || password !== process.env.IMPORT_PASSWORD) {
    return json({ error: 'Mot de passe incorrect' }, 401);
  }

  if (!from || !to) return json({ error: 'Dates de debut et de fin requises' }, 400);

  const dFrom = new Date(from);
  const dTo   = new Date(to);
  if (isNaN(dFrom.getTime()) || isNaN(dTo.getTime())) {
    return json({ error: 'Dates invalides' }, 400);
  }
  if (dFrom.getTime() > dTo.getTime()) {
    return json({ error: 'La date de debut doit preceder la date de fin' }, 400);
  }

  const fromIso = dFrom.toISOString();
  const toIso   = dTo.toISOString();

  // Construit le filtre commun (plage + device optionnel)
  const applyFilter = (q) => {
    let r = q.gte('received_at', fromIso).lte('received_at', toIso);
    if (deviceId) r = r.eq('device_id', deviceId);
    return r;
  };

  // --- Toujours : on compte ce qui serait touche ---
  const { data: rows, error: e1 } = await applyFilter(
    supabase.from('readings').select('received_at').order('received_at', { ascending: true })
  );
  if (e1) return json({ error: e1.message }, 500);

  const count = rows?.length || 0;
  const summary = {
    count,
    from: fromIso,
    to: toIso,
    firstMatch: rows?.[0]?.received_at || null,
    lastMatch:  rows?.[count - 1]?.received_at || null,
  };

  // --- Sans confirmation explicite : APERCU uniquement, rien n'est supprime ---
  if (confirm !== true) {
    return json({ ok: true, preview: true, ...summary });
  }

  if (count === 0) {
    return json({ ok: true, deleted: 0, ...summary });
  }

  // --- Suppression reelle ---
  const { error: e2 } = await applyFilter(supabase.from('readings').delete());
  if (e2) return json({ error: e2.message }, 500);

  return json({ ok: true, deleted: count, ...summary });
}
