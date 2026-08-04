# Station Meteo Costa Rica — site web (Vercel + Supabase)

Ce projet reçoit les donnees de votre capteur via un **webhook TTN**, les enregistre
dans **Supabase**, et sert une petite page en ligne. Il tourne gratuitement sur Vercel.

> Vous pouvez garder votre app Electron (MQTT) allumee en parallele pendant tout le
> developpement : TTN envoie chaque mesure a **toutes** les integrations en meme temps.
> Le webhook et Electron reçoivent donc la meme donnee, sans se gener.

---

## Ce qu'il vous faut avant de commencer

- Un compte **GitHub** (gratuit) — https://github.com
- Un compte **Vercel** (gratuit), cree en se connectant avec GitHub — https://vercel.com
- Votre projet **Supabase** deja cree, avec le schema deja applique (fait ✅)
- Vos identifiants Supabase : **Project Settings > API**
  - `Project URL` (ex : `https://xxxx.supabase.co`)
  - cle `service_role` (secrete)

---

## Etape 1 — Mettre ce code sur GitHub

1. Allez sur https://github.com/new
2. `Repository name` : par exemple `weather-costa-rica-web`
3. Laissez-le en **Private** (recommande), ne cochez rien d'autre, cliquez **Create repository**.
4. Sur la page qui s'affiche, cliquez sur le lien **« uploading an existing file »**.
5. **Glissez-deposez tous les fichiers de ce dossier** (le contenu du dossier
   `weather-web`, pas le dossier lui-meme) dans la zone d'upload.
   - Assurez-vous d'inclure le dossier `app/` et son contenu.
   - Le fichier `.gitignore` empeche d'envoyer les secrets : c'est voulu.
6. En bas, cliquez **Commit changes**.

> Astuce : si GitHub ne prend pas les sous-dossiers en glisser-deposer, installez
> **GitHub Desktop** (https://desktop.github.com), qui rend l'operation triviale.

---

## Etape 2 — Importer le projet dans Vercel

1. Allez sur https://vercel.com/new
2. Vercel liste vos depots GitHub. Cliquez **Import** en face de `weather-costa-rica-web`.
   (S'il ne s'affiche pas, cliquez « Adjust GitHub App Permissions » pour donner acces au depot.)
3. Vercel detecte automatiquement **Next.js** — ne touchez a rien dans « Build settings ».

---

## Etape 3 — Saisir les variables d'environnement

Toujours sur la page d'import Vercel, depliez la section **Environment Variables**
et ajoutez ces trois lignes (Name a gauche, Value a droite) :

| Name                   | Value                                             |
|------------------------|---------------------------------------------------|
| `SUPABASE_URL`         | votre Project URL Supabase                        |
| `SUPABASE_SERVICE_KEY` | votre cle `service_role` Supabase                 |
| `TTN_WEBHOOK_SECRET`   | un mot de passe long que vous inventez            |

> Pour `TTN_WEBHOOK_SECRET`, tapez au clavier une longue suite de caracteres
> (ex : `k7Fq2pLmWzR9tXvB4nJ8`). Notez-le, il resservira a l'etape 5.

Puis cliquez **Deploy**. Attendez ~1 minute que le build se termine.

---

## Etape 4 — Recuperer l'URL du webhook

Une fois deploye, Vercel vous donne une adresse du type :

```
https://weather-costa-rica-web.vercel.app
```

Votre webhook est donc :

```
https://weather-costa-rica-web.vercel.app/api/ttn
```

**Test rapide** : ouvrez cette URL dans un navigateur. Elle doit afficher
`TTN webhook up`. Si oui, la fonction est en ligne. ✅

---

## Etape 5 — Brancher le webhook dans TTN

1. Console TTN > votre application `weather-costa-rica`
2. Menu de gauche : **Integrations > Webhooks**
3. Cliquez **Add webhook** > choisissez **Custom webhook**
4. Remplissez :
   - **Webhook ID** : `vercel-supabase` (au choix)
   - **Webhook format** : `JSON`
   - **Base URL** : `https://weather-costa-rica-web.vercel.app`
   - Section **Additional headers** : ajoutez une ligne
     - Key : `X-Ttn-Secret`
     - Value : le meme secret que `TTN_WEBHOOK_SECRET` (etape 3)
5. Plus bas, dans **Enabled event types**, cochez **Uplink message** et mettez le chemin :
   - `/api/ttn`
6. Cliquez **Add webhook**.

---

## Etape 6 — Verifier que les donnees arrivent

1. Attendez qu'un uplink de votre capteur parte (selon votre intervalle d'emission).
2. Dans Supabase > **Table Editor** > table `readings` : une nouvelle ligne doit apparaitre.
3. En cas de souci, regardez les logs cote Vercel :
   **Vercel > votre projet > Logs**, et cote TTN : la page du webhook affiche les
   dernieres tentatives et le code de reponse (200 = OK, 401 = secret qui ne correspond pas).

---

## Rappels securite

- Ne committez jamais vos vraies cles. Le `.gitignore` protege les fichiers `.env`.
- La cle `service_role` ne doit **jamais** apparaitre cote navigateur ni sur GitHub.
- Si vous avez deja pousse une cle par erreur, revoquez-la et regenerez-en une.

---

## Et apres ?

Prochaine etape du projet : le **tableau de bord** (lecture de Supabase en temps reel
via la cle `anon` + Supabase Realtime), puis la migration de votre `readings.db`
existant vers Supabase, et enfin un domaine personnalise.

