# Watch Now clean-launch status

[Back to Watch Now](../README.md)

The clean source-repository handover is complete. The new `JermZone/watch-now`
was populated with one initial commit and remains private during preparation.
The previous repository is preserved as `JermZone/watch-now-legacy`; it has not
been deleted or placed into GitHub's archived state.

The initial source exactly matches the reviewed **1.0.0-rc.3** snapshot, and its
CI passed in the new repository. The maintainer confirmed the separate source
build starts healthy, accepts sign-in, and shows the correct name/version.
[Provenance](../PROVENANCE.md) records the repository IDs, source commits, and tree;
[release readiness](release-readiness.md) distinguishes these checks from earlier
playback evidence and the remaining registry-image verification.

The `release/1.0.0` preparation aligns the six version files and
[release notes](../RELEASE_NOTES.md) with **1.0.0**. It does not change playback
logic, dependencies, or the earlier testing record. A stable-looking version
number in source is not a publication or approval decision.

## Remaining launch work

Review the version-preparation PR and its exact-head CI, repository/package
permissions, and the deferred [Watch-button issue](https://github.com/JermZone/watch-now/issues/11).
Approve the final source and publication separately. Do not repeat the completed
feature checklist solely because names, documentation, or version labels changed.

Build the final versioned image, verify its exact digest, anonymous pull, startup,
and source/version labels, then publish the reviewed release assets and confirm
stable-only `latest` promotion. Follow [releases](releases.md) and
[migration](migration.md). Until those steps are verified, do not announce a
stable image, switch production stacks, or archive the legacy repository.
