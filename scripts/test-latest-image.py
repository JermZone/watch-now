#!/usr/bin/env python3
"""Offline regression tests for stable-only release promotion."""
import hashlib
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('promotion', pathlib.Path(__file__).with_name('resolve-latest-image.py'))
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)


def release(tag, **fields):
    result = dict(tag_name=tag, draft=False, prerelease=False, published_at='2026-10-01T00:00:00Z')
    result.update(fields)
    return result


class PromotionTests(unittest.TestCase):
    def manifest(self, digest, checksum=None, name='watch-now-1.0.0.tar.gz'):
        digest_hash = checksum or hashlib.sha256(digest).hexdigest()
        return f"{'0' * 64}  {name}\n{digest_hash}  image-digest.txt\n".encode()

    def test_uses_only_new_repository_and_image(self):
        self.assertEqual(promotion.REPO, 'JermZone/watch-now')
        self.assertEqual(promotion.IMAGE, 'ghcr.io/jermzone/watch-now')

    def test_orders_stable_versions_numerically(self):
        versions = [release('v1.0.9'), release('v1.0.10')]
        self.assertEqual(promotion.validate_release('v1.0.10', versions)['tag_name'], 'v1.0.10')
        with self.assertRaises(ValueError):
            promotion.validate_release('v1.0.9', versions)

    def test_newer_prereleases_neither_promote_nor_block_stable(self):
        versions = [release('v1.0.0'), release('v1.0.1', prerelease=True),
                    release('v2.0.0-rc.1', prerelease=True)]
        self.assertEqual(promotion.validate_release('v1.0.0', versions)['tag_name'], 'v1.0.0')
        for tag in ['v1.0.1', 'v2.0.0-rc.1']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                promotion.validate_release(tag, versions)

    def test_prerelease_suffix_is_rejected_even_with_stable_flag(self):
        with self.assertRaises(ValueError):
            promotion.validate_release('v1.0.0-rc.1', [release('v1.0.0-rc.1')])

    def test_drafts_unpublished_and_incomplete_states_cannot_promote(self):
        cases = [[], [release('v1.0.0', draft=True)],
                 [release('v1.0.0', published_at=None)],
                 [dict(tag_name='v1.0.0', published_at='2026-10-01')],
                 [release('v1.0.0', prerelease=None)],
                 [release('v1.0.0', prerelease='false')]]
        for versions in cases:
            with self.subTest(versions=versions), self.assertRaises(ValueError):
                promotion.validate_release('v1.0.0', versions)

    def test_rejects_invalid_or_absent_tags(self):
        versions = [release('v1.0.0'), release('nightly')]
        for tag in ['v1.0.1', 'nightly', '1.0.0', 'v01.0.0', 'v1.0.0\nimage=bad']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                promotion.validate_release(tag, versions)

    def test_accepts_only_checksummed_new_project_digest(self):
        digest = f"{promotion.IMAGE}@sha256:{'a' * 64}\n".encode()
        self.assertEqual(promotion.validate_manifest('v1.0.0', digest, self.manifest(digest)), digest.decode().strip())
        with self.assertRaises(ValueError):
            promotion.validate_manifest('v1.0.0', digest, self.manifest(digest, '0' * 64))
        for invalid in [b'other.example/project@sha256:' + b'a' * 64,
                        b'ghcr.io/jermzone/dispatcharr-now@sha256:' + b'a' * 64,
                        f'{promotion.IMAGE}:latest'.encode(), digest + b'image=bad\n']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                promotion.validate_manifest('v1.0.0', invalid, self.manifest(invalid))

    def test_rejects_old_or_wrong_archive_names(self):
        digest = f"{promotion.IMAGE}@sha256:{'a' * 64}\n".encode()
        for name in ['dispatcharr-now-1.0.0.tar.gz', 'watch-now-1.0.1.tar.gz', '../watch-now-1.0.0.tar.gz']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                promotion.validate_manifest('v1.0.0', digest, self.manifest(digest, name=name))

    def test_accepts_install_zip_from_release_workflow(self):
        digest = f"{promotion.IMAGE}@sha256:{'a' * 64}\n".encode()
        manifest = self.manifest(digest, name='watch-now-1.1.0.tar.gz')
        manifest += f"{'b' * 64}  watch-now-1.1.0-install.zip\n".encode()
        self.assertEqual(promotion.validate_manifest('v1.1.0', digest, manifest), digest.decode().strip())

    def test_rejects_wrong_duplicate_or_malformed_install_zip_entries(self):
        digest = f"{promotion.IMAGE}@sha256:{'a' * 64}\n".encode()
        manifest = self.manifest(digest, name='watch-now-1.1.0.tar.gz')
        entry = f"{'b' * 64}  watch-now-1.1.0-install.zip\n".encode()
        invalid_entries = [
            f"{'b' * 64}  {name}\n".encode() for name in [
                'watch-now-1.0.0-install.zip', 'dispatcharr-now-1.1.0-install.zip',
                '../watch-now-1.1.0-install.zip', 'unexpected.zip',
            ]
        ] + [entry + entry, b'not-a-hash  watch-now-1.1.0-install.zip\n']
        for invalid in invalid_entries:
            with self.subTest(entry=invalid), self.assertRaises(ValueError):
                promotion.validate_manifest('v1.1.0', digest, manifest + invalid)

    def test_rejects_missing_duplicate_or_malformed_manifest(self):
        digest = f"{promotion.IMAGE}@sha256:{'a' * 64}\n".encode()
        manifest = self.manifest(digest)
        for invalid in [manifest.splitlines(keepends=True)[1],
                        manifest + manifest.splitlines(keepends=True)[1], manifest + b'bad entry\n']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                promotion.validate_manifest('v1.0.0', digest, invalid)

    def test_missing_draft_status_cannot_promote(self):
        incomplete = release('v1.0.0')
        del incomplete['draft']
        with self.assertRaises(ValueError):
            promotion.validate_release('v1.0.0', [incomplete])

    def test_only_explicit_false_draft_status_can_promote(self):
        for status in [None, 0, '', [], {}, 'false', True]:
            with self.subTest(status=status), self.assertRaises(ValueError):
                promotion.validate_release('v1.0.0', [release('v1.0.0', draft=status)])

    def test_incomplete_newer_release_does_not_block_valid_stable(self):
        incomplete = release('v1.0.1')
        del incomplete['draft']
        self.assertEqual(
            promotion.validate_release('v1.0.0', [release('v1.0.0'), incomplete])['tag_name'],
            'v1.0.0',
        )

    def test_rejected_draft_state_stops_before_tag_or_download(self):
        incomplete = release('v1.0.0')
        del incomplete['draft']
        with patch.object(promotion, 'api', return_value=[[incomplete]]) as api, \
                patch.object(promotion.subprocess, 'run') as run, self.assertRaises(ValueError):
            promotion.main('v1.0.0')
        api.assert_called_once_with('releases?per_page=100', True)
        run.assert_not_called()

    def test_rc_rejected_before_any_network_call(self):
        with patch.object(promotion, 'api') as api, self.assertRaises(ValueError):
            promotion.main('v1.0.0-rc.1')
        api.assert_not_called()


    def test_missing_or_wrong_release_build_stops_before_download(self):
        sha = 'a' * 40
        built = dict(head_branch='v1.0.0', head_sha=sha, status='completed', conclusion='success')
        cases = [[], [dict(built, conclusion='failure')],
                 [dict(built, status='in_progress', conclusion=None)],
                 [dict(built, head_sha='b' * 40)], [dict(built, head_branch='v0.9.0')]]
        for runs in cases:
            with self.subTest(runs=runs), \
                    patch.object(promotion, 'api', side_effect=[
                        [[release('v1.0.0')]], {'object': {'type': 'commit', 'sha': sha}},
                        [{'workflow_runs': runs}]]), \
                    patch.object(promotion.subprocess, 'run') as download, \
                    self.assertRaisesRegex(ValueError, 'no successful release workflow'):
                promotion.main('v1.0.0')
            download.assert_not_called()

    def test_tag_must_resolve_to_commit(self):
        with patch.object(promotion, 'api', side_effect=[
                [[release('v1.0.0')]], {'object': {'type': 'tree', 'sha': 'a' * 40}}]), \
                patch.object(promotion.subprocess, 'run') as download, \
                self.assertRaisesRegex(ValueError, 'must identify a commit'):
            promotion.main('v1.0.0')
        download.assert_not_called()

    def test_annotated_tag_and_successful_build_emit_verified_digest(self):
        sha = 'a' * 40
        digest = f"{promotion.IMAGE}@sha256:{'b' * 64}\n".encode()
        def fake_download(args, *, check):
            self.assertTrue(check)
            self.assertEqual(args[:6], ['gh', 'release', 'download', 'v1.0.0', '--repo', promotion.REPO])
            folder = pathlib.Path(args[args.index('--dir') + 1])
            (folder / 'image-digest.txt').write_bytes(digest)
            (folder / 'SHA256SUMS').write_bytes(self.manifest(digest))
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'output'
            with patch.object(promotion, 'api', side_effect=[
                    [[release('v1.0.0')]], {'object': {'type': 'tag', 'sha': 'c' * 40}},
                    {'object': {'type': 'commit', 'sha': sha}},
                    [{'workflow_runs': [dict(head_branch='v1.0.0', head_sha=sha,
                                            status='completed', conclusion='success')]}]]) as api, \
                    patch.object(promotion.subprocess, 'run', side_effect=fake_download) as download, \
                    patch.dict(promotion.os.environ, {'GITHUB_OUTPUT': str(output)}):
                promotion.main('v1.0.0')
            self.assertEqual(output.read_text(), f"image={digest.decode().strip()}\ndigest=sha256:{'b' * 64}\n")
            api.assert_any_call('git/tags/' + 'c' * 40)
            api.assert_any_call(f'actions/workflows/release.yml/runs?event=push&head_sha={sha}&per_page=100', True)
            download.assert_called_once()

if __name__ == '__main__':
    unittest.main()
