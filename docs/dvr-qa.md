# DVR QA checkpoint

This candidate is for household QA on Docky, not a production release.
Forgejo `qa/dvr` is the integration branch; GitHub and both `main` branches
remain unchanged until QA sign-off. Web Video Caster remains shelved.

## Deployment

Use `compose.qa.yaml` as its own project, `watch-now-dvr-qa`. Build from the
committed QA revision with `VERSION=qa-dvr-<short revision>`, `REVISION=<full
revision>` and `SOURCE_URL` pointing to that Forgejo revision. Transfer the exact
image to Docky, compare image IDs after loading, and set `NOW_QA_IMAGE` to its
unique tag. The QA Compose file deliberately never pulls a moving registry tag.

On Docky, keep deployment files in `/home/jeremy/watch-now-dvr-qa`. Its private
`.env` selects the image, Dispatcharr address, LAN bind `192.168.68.106`, and
port `19195`. The master key lives in `secrets/dvr-master-api-key.txt`, mounted
read-only. Protect the directory with mode 0700 and allow container UID 65532 to
read the key file. Never attach these files to a PR or put credentials in QA notes.

The QA address is http://192.168.68.106:19195. Confirm the expected revision in
About before testing. The deployment record stored alongside Compose captures
the revision, image ID, and checks. Existing Docky stacks are not replaced.
To stop QA, run `docker compose -p watch-now-dvr-qa -f compose.qa.yaml down` from
that deployment directory. Recording jobs continue in Dispatcharr.

## Evidence and sign-off

Record the candidate revision, date, device/browser or VLC version, account
access level, result, and any issue for each check in the Forgejo QA PR.
Automated fixture tests are distinct from household testing. Earlier successful
Loki recording/playback and UI feedback are useful evidence, but do not count
as retesting this exact Docky image.

| Check | Required household result |
| --- | --- |
| Standard/view | Browse and play allowed; recording mutations unavailable |
| Standard/manage and Admin | Schedule and management controls work on allowed channels |
| Disabled DVR / restricted lineup | Denied actions and inaccessible channels stay unavailable |
| Upcoming and details | Record the selected channel and exact airing; duplicate clicks do not duplicate it |
| Scheduled | Cancel one disposable future recording; confirm it disappears |
| Recording | Record a disposable current airing; extend 30 minutes and stop |
| Recorded | Wait for processing; browser Watch/Stop, seek, download and VLC work |
| Delete | Confirm deletion of only the disposable recording |
| Refresh and search | Status changes appear automatically; status search and empty-state shortcut behave correctly |
| Sessions | Log out and back in without entering an API key; expired VLC handoffs are rejected |
| Devices | Desktop/mobile menu, Color selector and DVR layout are usable |
| Regression | Live TV, Movies and Series browse/search/playback still work |

Recording changes affect shared Dispatcharr resources. Use expendable airings;
never cancel or delete someone else's recording as a QA shortcut.

Pass requires the household checks above and no unresolved blocking defects.
Each source fix creates a new candidate with a new tag, followed by targeted
retesting and regression checks. The user supplies final QA sign-off before any
GitHub publication or Nebula deployment.

## Deferred

Playback during recording, saved resume positions, pause/start-over live TV,
recurring rules, automatic commercial skipping and discovery beyond 24 hours
are outside this checkpoint. See [DVR implementation](dvr.md) for limitations.
