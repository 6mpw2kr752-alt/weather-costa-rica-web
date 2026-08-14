// app/api/day-meta/route.js
// Ecriture protegee par mot de passe du "lieu" et de la "note" d'une journee.
//
// La LECTURE reste publique : le dashboard lit day_metadata avec la cle anon.
// L'ECRITURE passe obligatoirement par ici. Le navigateur ne recoit jamais la
// cle service_role, et la table est fermee en RLS (voir rls-day-metadata.sql) :
// sans ce verrou cote base, le cadenas de la page serait purement decoratif.
//
// Variables d'environnement (Vercel > Settings > Environment Variables) :
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   (deja presentes)
//   META_PASSWORD                        (a ajouter ; sinon IMPORT_PASSWORD sert de secours)

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

// Comparaison a duree constante : une comparaison classique (===) s'arrete au
// premier caractere different, ce qui laisse deviner le mot de passe lettre par
// lettre en mesurant le temps de reponse.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'JSON invalide' }, 400);
  }

  const { password, day, location, note, check } = body;

  const expected = process.env.META_PASSWORD || process.env.IMPORT_PASSWORD;
  if (!expected) return json({ error: 'META_PASSWORD non configure' }, 500);

  if (!safeEqual(String(password || ''), expected)) {
    return json({ error: 'Mot de passe incorrect' }, 401);
  }

  // Bouton "Unlock" : on verifie juste le mot de passe, on n'ecrit rien.
  if (check === true) return json({ ok: true });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
    return json({ error: 'Jour invalide (format attendu : AAAA-MM-JJ)' }, 400);
  }

  const clean = (v) => String(v ?? '').trim().slice(0, 500);

  const { error } = await supabase
    .from('day_metadata')
    .upsert(
      { day, location: clean(location), note: clean(note) },
      { onConflict: 'day' }
    );

  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, day });
}
