# The Playroom

Vanilla JS home-screen web app (no build step), hosted on GitHub Pages from `main` / root.

## Releasing
- Every push that changes app files: bump `APP_VERSION` in app.js AND `version.json` to the same value (format `YYYY.MM.DD-N`). Phones compare these to show the "new version" banner.
- Bump `CACHE` in sw.js when the file list changes.

## Data
- All user data is in localStorage key `playroom.v1`. Never rename it.
- Starter content lives in seed.js. When adding or changing starter activities or toys, bump `SEED_VERSION`.
  Unedited starter activities are replaced with the new definitions on load; edited ones (`edited: true`) and custom ones are kept.
  To drop a starter activity, list its id in `REMOVED_SEED_IDS`.
- Activities link to toys via `toys: [toyId]` (ids in `TOYS`).
- Toy list comes from Merritt's Closet (Firestore doc `wishlists/w_f6Un6k7se0dvifVErHRe`, field `toys`).
