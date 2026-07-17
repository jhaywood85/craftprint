# 📱 Put CraftPrint on your son's iPad

CraftPrint installs as a **home-screen app** (a PWA): it gets its own icon,
opens fullscreen with no Safari bars, and works **offline** once loaded. No
App Store, no Apple account, no Xcode.

There are two ways to do it. Pick whichever fits.

---

## Option A — Serve from your Mac (quickest, great for trying it out)

Your Mac runs the game; the iPad opens it over your home Wi-Fi.

1. On the **Mac**, double-click **`play.command`** in the CraftPrint folder.
   A terminal window opens and prints two addresses, e.g.:

   ```
   On this Mac:   http://localhost:4173
   On the iPad:   http://192.168.1.170:4173   (same Wi-Fi, open in Safari)
   ```

2. On the **iPad** (same Wi-Fi as the Mac), open **Safari** and type in that
   `http://192.168.1.170:4173` address (your numbers may differ — use the ones
   the terminal shows).

3. Tap the **Share** button (the square with an up-arrow) → **Add to Home
   Screen** → **Add**.

4. CraftPrint now has an icon on the iPad. Tap it — it opens fullscreen.

**Note:** because the Mac is the server, the Mac must be **on and running
`play.command`** while your son plays this way. For a version that lives fully
on the iPad, use Option B.

---

## Option B — Host it once, then it lives on the iPad forever

Put the files on any static web host (all free tiers work great):
**GitHub Pages**, **Netlify Drop** (literally drag the folder onto
netlify.com/drop), **Cloudflare Pages**, etc. Then:

1. On the iPad, open the hosted URL (e.g. `https://yourname.github.io/craftprint/`)
   in **Safari**.
2. **Share → Add to Home Screen → Add.**
3. Open it once so it caches. After that it works **offline** — the Mac can be
   off, the Wi-Fi can be down, and the app still runs. Perfect for car rides.

That's the closest thing to a "real app" without the App Store, and it's what
I'd recommend for everyday use.

---

## Things worth knowing

- **It must be opened in Safari** for "Add to Home Screen" to appear (Chrome on
  iOS can't install PWAs — that's an Apple limitation).
- **Saving an STL from the iPad:** tap **🖨️ Print It! → Make my STL file** and
  iOS shows the Files sheet — save to iCloud Drive or "On My iPad," then grab
  it on the Mac (or AirDrop it) to load into your slicer.
- **Everything is private and offline.** Nothing is uploaded anywhere; saves
  live in the browser's storage on the iPad.
- **Updating the app:** if you change the game and re-host it, bump the
  `CACHE` version string at the top of `sw.js` (e.g. `craftprint-v4` →
  `craftprint-v5`). That tells installed copies to pull the new files instead
  of the cached ones.

## Want a true App Store / sideloaded app later?

The game is already structured so it can be wrapped with **Capacitor** into a
real native iOS app (native share sheet for STLs, installable via Xcode on your
Mac). That's a bigger step — say the word and I'll set it up.
