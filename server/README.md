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

5. In CraftPrint, open **🏫 Class → For grown-ups**, paste that address, and
   press Save. Done — Create a class / Join a class now work on every device
   pointed at that address.

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
