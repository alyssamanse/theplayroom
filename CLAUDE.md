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
- Activities link to toys via `toys: [toyId]` (ids in `TOYS`) and to milestones via `needs: [milestoneId]` (ids in `MILESTONES`).
  Milestone gating only applies once `milestonesSetup` is true.
- Templates live in `state.templates.days` / `.windows`.
- Toy list comes from Merritt's Closet (Firestore doc `wishlists/w_f6Un6k7se0dvifVErHRe`, field `toys`).

## Sync (sync.js)
- Firebase project `the-playroom-5bd48`. Firestore: `playrooms/family` holds `{json}` of settings/library/toys; `playrooms/family/days/{YYYY-MM-DD}` holds each day's plan as `{date, json}`.
- localStorage stays the source of truth on each phone; sync mirrors it. Unsent changes are tracked in localStorage `playroom.sync`.
- Access is controlled only by Firestore rules (allowlist of verified emails). Lys and Michael both have full edit access.
- Firebase SDK loads from gstatic only after sign-in, so the app works with no network.

## Deploying
- GitHub Pages deploys can fail when pushes overlap. Batch changes into one push when possible, then check
  `gh api "repos/alyssamanse/theplayroom/actions/runs?per_page=3"` and confirm the live `version.json` matches.
