# Watch Now clean-launch plan

[Back to Watch Now](../README.md)

The preparation candidate is **1.0.0-rc.3**, not a stable release or a published
image. The code/package names, new-user documentation, and release checks are
prepared together. Publishing stays disabled until explicitly approved.

The current baseline includes the rebrand and repeated-session tests. Preserve
those tests, all license notices, and the original history. This cleanup does not
fix the deferred Watch-button report; review its status honestly before release.

## Remaining handover

Use [release readiness](release-readiness.md) to record automated checks and real
installation/playback evidence against the exact source and image. Use
[migration](migration.md) for the optional fresh repository and existing-stack
transition. [Provenance](../PROVENANCE.md) records the originating source.

The fresh repository/new package can start at **1.0.0** after approval. Do not reuse
published tags in the current repository. Rename/archive work is a separate step;
reusing an old repository name stops its redirect, so check old links and package
permissions explicitly. Neither a clean history nor a green test run automatically
qualifies the project as stable.
