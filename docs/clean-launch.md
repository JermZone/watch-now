# Watch Now clean-launch record

[Back to Watch Now](../README.md)

The clean source-repository handover and first stable publication are complete.
The canonical repository is
[JermZone/watch-now](https://github.com/JermZone/watch-now), with a clean initial
commit derived from the reviewed 1.0.0-rc.3 snapshot.

The clean initial source matched the reviewed snapshot by Git tree and passed CI
in the new repository. The maintainer separately confirmed the rc.3 source build
started healthy, accepted sign-in, and showed the correct name/version.
[Provenance](../PROVENANCE.md) records the source handover without requiring the
former development repository to remain online.

Watch Now 1.0.0 was then prepared without runtime or dependency changes, passed
its release CI, and was published with checksummed release assets. The public
image was anonymously pulled and started healthy on an isolated Linux AMD64
stack. The published-release promotion workflow verified the checksummed digest
and promoted that exact image to `latest`.

The verified 1.0.0 image digest is:

`sha256:3db3b5f3655eed2579797800aeb965b69081c161271bbd577b61fc7f73dd7bc5`

The deferred [Watch-button issue](https://github.com/JermZone/watch-now/issues/11)
remains open. Earlier playback evidence is retained with its original scope; the
full feature checklist was not repeated on the final image.

The former development repository is no longer required for installation,
release verification, rollback, or ongoing issue tracking. Relevant historical
identifiers and evidence have been carried forward into this repository.

See [release readiness](release-readiness.md), [migration](migration.md), and
[release notes](../RELEASE_NOTES.md).
