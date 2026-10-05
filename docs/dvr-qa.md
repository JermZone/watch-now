# DVR QA checkpoint

This checklist records the DVR/Guide release scope. The maintainer approved
production publication on 2026-10-05 after the private QA deployment. Web Video
Caster was subsequently canceled by the maintainer on 2026-10-05. Deployment-specific records remain with the private QA
stack; do not publish keys or private environment files.

## Isolated QA deployment

Use `compose.qa.yaml` as a separate project. Build the committed revision with a
unique image tag and matching VERSION/REVISION labels. Transfer the exact image,
compare image IDs, and select it with `NOW_QA_IMAGE`. The QA Compose file deliberately
never pulls a moving registry tag. Preserve the prior image and Compose settings
for rollback. Protect secret directories and allow container UID 65532 to read
mounted key files. Confirm the expected revision in About before testing.

## Evidence and sign-off

Record the candidate revision, date, device/browser or VLC version, account
access level, result, and any issue for each check in the release QA record.
Automated fixture tests are distinct from household testing. Earlier successful
development recording/playback and UI feedback are useful evidence, but do not count
as retesting the exact release image.

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
retesting and regression checks. Maintainer approval authorizes publication; retain
any unrun manual checks as limitations rather than claiming them passed.

## Deferred

Playback during recording, saved resume positions, pause/start-over live TV,
recurring rules, and automatic commercial skipping are outside this checkpoint.
Search remains limited to 24 hours; the Guide supports later airings. See [DVR implementation](dvr.md) for limitations.
