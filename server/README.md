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

## Deploy it (once)

1. Make a free account at https://dash.cloudflare.com/sign-up (no card needed).
2. On any computer with Node.js, in this `server/` folder:

   ```bash
   npx wrangler login                          # opens a browser to authorize
   npx wrangler kv namespace create ROOMS      # prints an id
   ```

3. Paste the printed `id` into `wrangler.toml` where it says
   `PASTE_YOUR_KV_NAMESPACE_ID_HERE`.
4. Deploy:

   ```bash
   npx wrangler deploy
   ```

   It prints your server address, something like
   `https://craftprint-class.yourname.workers.dev`.

5. In CraftPrint, open **🏫 Class → 🍎 I'm a teacher → ⚙️ Server**, paste
   that address, and press **Save & check** — it verifies the server
   instantly. Done.

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
| The app (static files) | **GitHub Pages** (or Cloudflare Pages) | ~100 GB/month bandwidth — the app is a couple of MB and then cached offline on each tablet, so this is effectively unlimited for a school |
| Classroom server | **Cloudflare Workers + KV** | ~100,000 requests/day, and **~1,000 KV writes/day** |

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

## Try it locally first (optional)

```bash
node server/dev.mjs          # same code, in-memory storage, port 8787
```

Then paste `http://localhost:8787` as the server address in the app.

## Privacy notes for schools

- Stored data per student: first name, a design name, and the block data.
  Nothing else — no emails, no passwords, no tracking.
- The teacher key never leaves the teacher's browser except on their own
  requests; students cannot read each other's designs.
- Everything expires after 60 days of inactivity. Deleting the Worker (or
  the KV namespace) erases all data instantly.
