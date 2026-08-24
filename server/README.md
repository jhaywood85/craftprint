# CraftPrint Classroom server — 5-minute deploy guide

The Classroom feature (room codes, students handing in designs, teacher
downloads) needs one tiny server. It runs free on Cloudflare Workers — the
free tier handles far more than a classroom will ever use.

## What you get

- Teachers press **Create a class** and get a 5-letter room code to write on
  the whiteboard.
- Students press **Join a class**, type the code and their first name — no
  passwords, no accounts, no email addresses (nothing personal beyond a first
  name is ever stored).
- Students press **Hand in my build**; the teacher's Class screen lists every
  design and downloads them all for 3D printing.
- Rooms clean themselves up automatically after 60 days.

## How it deploys

ONE Cloudflare Worker serves everything: the app itself (static files built
into `dist/` by `scripts/build-app.sh`) and the `/api/*` Classroom/accounts
endpoints (`worker.js`). So the app and its API share one URL, and GitHub
Pages isn't needed — the repository can stay private.

**Automatic (how this repo works):** every push to `main` runs the test
suite and deploys via GitHub Actions (`.github/workflows/deploy.yml`).
One-time setup — add two repository secrets under GitHub → Settings →
Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN` — create at dash.cloudflare.com → My Profile →
  API Tokens → **Create Token** → use the **Edit Cloudflare Workers**
  template (scope it to your account).
- `CLOUDFLARE_ACCOUNT_ID` — shown in the right sidebar of the Workers
  overview page (also in any `wrangler` output).

**By hand (first-ever deploy, or without CI):**

1. Make a free account at https://dash.cloudflare.com/sign-up (no card needed).
2. On any computer with Node.js, in the repo root:

   ```bash
   cd server
   npx wrangler login                          # opens a browser to authorize
   npx wrangler kv namespace create ROOMS      # prints an id
   ```

3. Paste the printed `id` into `wrangler.toml` (the `kv_namespaces` entry).
4. Build the app and deploy:

   ```bash
   cd .. && ./scripts/build-app.sh
   cd server && npx wrangler deploy
   ```

   It prints your address, something like
   `https://craftprint-class.yourname.workers.dev` — that's the whole app,
   with the Classroom API under `/api/`.

Students never touch any of this: the teacher's Class screen shows a QR
code / join link that carries the room code *and* server address, so
student tablets configure themselves the moment they scan it.

**Tip for schools:** to make the server the built-in default for everyone
using your copy of the app (so even the QR isn't needed for setup), put the
address in `DEFAULT_SERVER` at the top of `src/classroom.js` and redeploy
the site.

## Running it for a whole school (free tier)

Both halves of CraftPrint are designed to sit inside free hosting tiers, with
no card on file:

| Piece | Free host | What the free tier gives you |
| --- | --- | --- |
| The app (static files) | **Cloudflare Workers static assets** (same Worker) | Asset requests are free and unlimited on the Workers free plan, and the app caches offline on each tablet after the first load |
| Classroom server | **Cloudflare Workers + KV** (same Worker) | ~100,000 requests/day, and **~1,000 KV writes/day** |

The KV write limit is the only meaningful ceiling, and it's the one to size
against: **each hand-in costs one write.** So roughly:

- a 30-student class handing in 3 versions each ≈ 90 writes
- that's ~10 classes a day on the free tier, with headroom to spare
- reads (teachers refreshing, students joining) come out of the 100k/day
  bucket and are nowhere near the limit

If a district outgrows that, the Workers paid plan is $5/month for millions of
operations — no code changes needed. Cloudflare Pages is worth considering for
the static app too (unmetered bandwidth on the free plan).

### Protect a shared server with a teacher passcode

Anyone who learns your server address could otherwise create rooms and burn
the daily quota. For a server shared across a school, set a staff passcode:

```bash
npx wrangler secret put CREATE_PASSCODE     # type the passcode when prompted
```

Teachers then enter that passcode once when creating a class (the app asks
for it automatically — it checks the server and only shows the field when one
is required). **Students are unaffected**: joining and handing in never need
a passcode. Leave the secret unset for a single family or classroom, where
open creation is simpler.

## Teacher accounts — "Sign in with Google" (optional)

Teachers can sign in with their Google account to keep a personal cloud copy
of their designs (☁️ Cloud in **📦 My Stuff**) that survives cleared browsers
and follows them to any device. No passwords are ever created or stored —
Google proves who they are; this server keeps only their email, display name,
and saved designs.

One-time setup (about 10 minutes):

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create
   a project (any name, e.g. `craftprint-class`).
2. **APIs & Services → OAuth consent screen**: choose **External**, fill in
   the app name and your email, add no extra scopes, and add yourself as a
   test user (publish the app when you're ready for all teachers).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   type **Web application**, and under *Authorized redirect URIs* add
   `https://YOUR-WORKER-URL/api/auth/google/callback`
   (your `workers.dev` address from the deploy step).
4. Give the Worker its three secrets:

   ```bash
   wrangler secret put GOOGLE_CLIENT_ID       # from step 3
   wrangler secret put GOOGLE_CLIENT_SECRET   # from step 3
   wrangler secret put SESSION_SECRET         # any long random string
   ```

   (`openssl rand -hex 32` makes a good SESSION_SECRET.)

That's it — the app notices the server supports sign-in (via `/api/health`)
and shows the **🔑 Sign in with Google** button automatically, both in
My Stuff and in the teacher's Class setup. Accounts get up to 200 synced
designs each; sessions last 90 days.

With sign-in enabled, **classes belong to the teacher's account**: they
appear on every device the teacher signs into, all teacher actions work with
the sign-in alone, and closing a class deletes it (and its hand-ins) for
good. The old teacher-key files still work for classes created without an
account, and such a class can be attached to an account with one tap
(“☁️ Move into my account”).

## Try it locally first (optional)

```bash
node server/dev.mjs          # same code, in-memory storage, port 8787
```

Then paste `http://localhost:8787` as the server address in the app.

To try accounts locally without a real Google client, use the test-only
fake sign-in (never set `GOOGLE_FAKE` on a deployed server):

```bash
SESSION_SECRET=dev GOOGLE_FAKE=you@example.com node server/dev.mjs
```

## Privacy notes for schools

- Stored data per student: first name, a design name, and the block data.
  Nothing else — no emails, no passwords, no tracking.
- The teacher key never leaves the teacher's browser except on their own
  requests; students cannot read each other's designs.
- Teacher accounts (if enabled) store only the teacher's email, display name,
  and their own saved designs. Sign-in goes through Google — no passwords
  exist anywhere in CraftPrint. Students never sign in to anything.
- Everything expires after 60 days of inactivity. Deleting the Worker (or
  the KV namespace) erases all data instantly.
