# Desktop viewport layout QA

The desktop viewer uses the browser viewport with scrolling inside the channel,
program, guide, search, catalog, and DVR panes. Header and discovery navigation
stay visible. Phone portrait and touch-landscape layouts retain page scrolling.
The Guide's existing horizontal time controls remain available.

## Automated browser regression

Run the standard Go/frontend/release checks first. After `npm run build` in
`frontend`, use an installed Playwright and its Chromium browser:

```sh
node scripts/test-desktop-layout.cjs
```

This optional development check does not add a production dependency. Set
`PLAYWRIGHT_MODULE` to an existing Playwright module path if it is not on Node's
module search path, and `PLAYWRIGHT_BROWSERS_PATH` if its browsers are elsewhere.
`NOW_LAYOUT_DIST` can select another built frontend directory;
`NOW_LAYOUT_SCREENSHOTS` can select an output directory for synthetic screenshots.
The test serves only synthetic data on a temporary loopback port. It does not
contact Dispatcharr, log in with real credentials, or play/record real media.

Checks cover document and outer-content overflow, usable inner scroll regions,
keyboard access to the last virtual channel, search return position, Guide Grid
and List, dedicated Guide player sizing/Stop/Back, long dialogs, Movies/Series
catalog and details, DVR, and About. Desktop sizes include 1920×1080,
1366×768, 1024×600, 960×540 (a smaller CSS viewport relevant to zoom), and 800×400.
Phone checks use 390×844 and 844×390 with touch input. Reduced viewport checks
are not a claim of manual browser zoom or device testing.

## Staged testing

1. Loki development: use a unique preview image, verify startup and authenticated
   access boundaries, and manually test the real lineup at the existing test URL.
   Keep one known-good container/image for rollback. A working-tree preview is
   not a release candidate and must identify itself accordingly.
2. Docky QA: after Loki acceptance, commit the reviewed candidate, build with
   matching version/revision labels, transfer the exact image, compare image IDs,
   and update only the isolated QA stack. Follow the existing QA deployment
   procedure in [DVR QA](dvr-qa.md).
3. Nebula production: only after QA acceptance, complete the normal reviewed
   release/distribution procedure and retain the production rollback digest.

Manual checks still required on the candidate:

- Desktop Browse/Search/Guide: no page scrollbar in either direction; inner panes
  scroll by wheel, scrollbar, and keyboard. Resize and test 200% browser zoom.
- Channel selection, long descriptions, full-day Guide time navigation, channel
  pagination, Grid/List switching, recording dialogs, and error/retry states.
- Browser playback, Stop, VLC handoff, and Back preserve navigation and controls.
- Movies, Series, and DVR: all titles/episodes/recordings and bottom actions remain
  reachable; long modal content and menu Sign out remain reachable on short windows.
- Phone portrait/landscape, permissions, and sign-out/sign-in regression.

Synthetic layout checks do not establish device codec compatibility, live
Dispatcharr recording behavior, or resolution of the deferred Watch-button issue.

## Loki checkpoint — 2026-10-05

`desktop-scroll-preview-1` is deployed to Loki's existing isolated Guide test
instance. It is a working-tree build based on `b2ce20b`, not a committed release
candidate. The previous container is retained for rollback.

Go tests/vet, all 198 frontend tests, the frontend and Docker builds,
Compose/release checks, and `git diff --check` passed. Browser geometry checks
passed at the desktop and phone sizes above. The frontend build retains its
existing bundle-size warning.

The deployed preview passed liveness, upstream readiness, static asset/version
checks, and anonymous session/Guide/DVR denial checks. Household acceptance on
Loki, Docky QA, and Nebula production promotion remain pending. After explicit cleanup approval, 27 obsolete Loki test containers and 32 unused
preview/build image tags were removed. The current desktop preview, its immediate
rollback container, deferred Web Video Caster work, and release/QA checkpoint
images were retained. Volumes and secret files were not removed.


## Dedicated player follow-up — 2026-10-05

`desktop-scroll-preview-2` fixes the dedicated Guide player’s inner vertical
scrollbar. The video now uses the space remaining after channel controls,
playback notices, panel padding, and the Now playing caption. The regression
first reproduced preview 1 overflowing its 939px player pane to 1002px, then
passed with the fix across all five desktop sizes, including wrapped captions.
Phone layout remains unchanged, and switching frame sizing keeps the video DOM
node mounted. All 199 frontend tests, Go tests/vet, frontend/Docker builds,
packaging checks and browser layout checks passed. Preview 1 is retained for
rollback; household acceptance and Docky/Nebula promotion remain pending.

## Guide loading follow-up — 2026-10-05

`desktop-scroll-preview-3` removes Grid's redundant Load more channels button.
Grid still starts with 50 channels and appends 10 on downward scroll, now retaining
up to 500 channels rather than 100. The 10,000-airing bound and virtualized rows
remain unchanged. Next channels is available at a batch boundary; List retains
manual loading and its existing limits. The expanded regression exercises all
100 API pages to reach 500 channels, verifies bounded rendered rows and continuation
to a fresh batch, and confirms the normal Grid loading button is absent.

## QA candidate acceptance — 2026-10-05

The maintainer accepted Loki preview 3 and requested promotion to Docky QA.
This acceptance covers the desktop layout, dedicated player sizing, and automatic
Grid loading changes. It does not authorize a production release. Record the
committed candidate, exact transferred image identity, deployment checks and
rollback location in the private QA deployment record. Manual Docky acceptance
remains pending.


## Docky deployment and repository cleanup — 2026-10-05

Docky QA is running `qa-desktop-802de3e` from commit
`802de3e1144318260830cd8b7db8496c440d1944`. Local and transferred image identities
matched. Liveness, upstream readiness, anonymous session/Guide/DVR denial,
version/revision labels, and Docker health passed. Deployment preserved the
existing QA configuration and retained its previous image and a rollback script.
The private deployment record holds the exact image ID and rollback location.
Nebula production remains unchanged, and manual Docky acceptance is pending.

The QA branch is backed up on Forgejo. The maintainer canceled Web Video Caster;
its local prototype stash, branch, test container, images, and temporary build
files were removed. Earlier references to retaining that work describe the
historical cleanup checkpoint, not the current plan. No WVC code was merged into
the desktop candidate. This documentation follow-up does not change the deployed
candidate's application code.
