#!/usr/bin/env python3
"""Offline checks for canonical branding, version metadata, and public packaging."""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import tempfile
import urllib.error
import unittest
from unittest import mock
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def text(path):
    return (ROOT / path).read_text(encoding='utf-8')


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


packaging = load_script('prepare-release')
safety = load_script('check-release-target')


class ReleaseConsistencyTests(unittest.TestCase):
    def setUp(self):
        self.package = json.loads(text('frontend/package.json'))
        self.version = self.package['version']

    def test_package_and_lockfile_root_match(self):
        self.assertRegex(self.version, r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$')
        self.assertEqual(self.package['name'], 'watch-now-frontend')
        self.assertTrue(self.package['private'])
        lock = json.loads(text('frontend/package-lock.json'))
        for obj in [lock, lock['packages']['']]:
            self.assertEqual(obj['version'], self.version)
            self.assertEqual(obj['name'], self.package['name'])

    def test_compose_examples_share_version_and_service(self):
        expected = '${NOW_IMAGE:-ghcr.io/jermzone/watch-now:' + self.version + '}'
        for name in ['compose.yaml', 'compose.release.yaml']:
            with self.subTest(name=name):
                self.assertIn(expected, text(name))
                self.assertIn('\n  watch-now:\n', text(name))
                self.assertNotIn('dispatcharr-now', text(name))
        self.assertEqual(text('compose.yaml'), text('compose.release.yaml'))
        self.assertIn('VERSION: ' + self.version, text('compose.build.yaml'))
        self.assertIn('image: watch-now:local', text('compose.build.yaml'))
        self.assertIn('pull_policy: build', text('compose.build.yaml'))
        self.assertIn('# NOW_IMAGE=ghcr.io/jermzone/watch-now:' + self.version, text('.env.example'))

    def test_go_imports_and_executable_use_watch_now(self):
        self.assertTrue(text('go.mod').startswith('module github.com/JermZone/watch-now\n'))
        self.assertTrue((ROOT / 'cmd/watch-now/main.go').is_file())
        self.assertFalse((ROOT / 'cmd/dispatcharr-now').exists())
        for path in [*ROOT.glob('cmd/**/*.go'), *ROOT.glob('internal/**/*.go')]:
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertNotIn('github.com/JermZone/dispatcharr-now', path.read_text())
                self.assertNotIn('Dispatcharr Now', path.read_text())
        dockerfile = text('Dockerfile')
        self.assertIn('ENTRYPOINT ["/watch-now"]', dockerfile)
        self.assertIn('CMD ["/watch-now", "healthcheck"]', dockerfile)
        self.assertNotIn('dispatcharr-now', dockerfile)

    def test_workflows_use_new_image_and_guard_publication(self):
        for path in ['.github/workflows/release.yml', '.github/workflows/latest.yml']:
            source = text(path)
            with self.subTest(path=path):
                self.assertIn("vars.WATCH_NOW_RELEASE_ENABLED == 'true'", source)
                self.assertIn('ghcr.io/jermzone/watch-now', source)
                self.assertNotIn('dispatcharr-now', source)
        self.assertIn('github.event.release.prerelease == false', text('.github/workflows/latest.yml'))
        release = text('.github/workflows/release.yml')
        self.assertIn('scripts/prepare-release.py prepare "$VERSION"', release)
        self.assertIn('scripts/prepare-release.py finalize "$VERSION" --digest "$IMAGE_DIGEST"', release)
        self.assertEqual(release.count('scripts/check-release-target.py "$RELEASE_TAG"'), 2)
        self.assertNotIn('--clobber', release)
        self.assertNotIn('--generate-notes', release)
        self.assertIn('--notes-file "$RUNNER_TEMP/watch-now-release-notes.md"', release)
        self.assertLess(release.index('scripts/prepare-release.py prepare'), release.index('name: Publish verified image'))
        self.assertLess(release.index('name: Scan the exact published image'), release.index('name: Publish GitHub release assets'))
        self.assertIn('image-ref: ghcr.io/jermzone/watch-now@${{ steps.publish.outputs.digest }}', release)
        latest = text('.github/workflows/latest.yml')
        self.assertLess(latest.index('name: Scan the exact release image'), latest.index('name: Promote exact image'))
        self.assertIn('image-ref: ${{ steps.release.outputs.image }}', latest)
        self.assertTrue({'compose.dvr.yaml', 'compose.dvr-master.yaml', 'THIRD_PARTY_NOTICES.md', 'PROVENANCE.md'} <= packaging.ROOT_FILES)

    def test_feature_images_have_no_registry_credentials_or_write_permissions(self):
        source = text('.github/workflows/development-image.yml')
        self.assertIn("branches: ['feature/**']", source)
        permissions = list(re.finditer(r'(?m)^( *)permissions:[ \t]*([^\n]*)\n', source))
        self.assertTrue(permissions)
        for permission in permissions:
            inline = permission[2].split('#', 1)[0].strip()
            if inline:
                self.assertIn(inline, ['{}', 'read-all'])
                continue
            for line in source[permission.end():].splitlines():
                if not line.strip() or line.lstrip().startswith('#'):
                    continue
                if len(line) - len(line.lstrip()) <= len(permission[1]):
                    break
                self.assertRegex(line, r'^ +[\w-]+: *[\'\"]?(read|none)[\'\"]? *(?:#.*)?$')
        self.assertNotRegex(source, r'(?i)\b(secrets|GH_TOKEN|GITHUB_TOKEN)\b|github\.token|ghcr\.io')
        self.assertNotRegex(source, r'(?i)docker/(login|build-push)-action|\bdocker\s+(login|push)\b')
        checkouts = [step for step in re.split(r'(?m)^      - ', source) if 'uses: actions/checkout@' in step]
        self.assertTrue(checkouts)
        for checkout in checkouts:
            self.assertRegex(checkout, r'(?m)^          persist-credentials: false$')

    def test_feature_artifact_contains_only_the_successfully_tested_local_image(self):
        source = text('.github/workflows/development-image.yml')
        scan = source.index('      - name: Scan development candidate')
        smoke = source.index('      - name: Smoke test the scanned image')
        archive = source.index('      - name: Archive the scanned and smoke-tested image')
        upload = source.index('      - name: Upload development image for separate testing')
        end = source.index('      - name:', upload + 1)
        self.assertLess(scan, smoke)
        self.assertLess(smoke, archive)
        self.assertLess(archive, upload)
        self.assertNotRegex(source[scan:end], r'(?m)^ +(if|continue-on-error):')
        self.assertIn('image="watch-now:dev-$REVISION"', source)
        self.assertIn('image-ref: watch-now:development', source[scan:smoke])
        self.assertIn("exit-code: '1'", source[scan:smoke])
        self.assertIn('watch-now:development', source[smoke:archive])
        self.assertIn('        shell: bash\n', source[archive:upload])
        self.assertIn('IMAGE: ${{ steps.image.outputs.image }}', source[archive:upload])
        self.assertIn('docker tag watch-now:development "$IMAGE"', source[archive:upload])
        self.assertIn('docker save "$IMAGE" | gzip > "$RUNNER_TEMP/development-image/watch-now-image.tar.gz"', source[archive:upload])
        self.assertNotIn('docker build', source[archive:])
        self.assertIn('sha256sum watch-now-image.tar.gz > SHA256SUMS', source[archive:upload])
        self.assertIn('uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', source[upload:end])
        paths = re.search(r'(?m)^          path: \|\n((?:            [^\n]+\n)+)', source[upload:end])
        self.assertIsNotNone(paths)
        self.assertEqual([line.strip() for line in paths[1].splitlines()], [
            '${{ runner.temp }}/development-image/watch-now-image.tar.gz',
            '${{ runner.temp }}/development-image/SHA256SUMS'])
        self.assertIn('if-no-files-found: error', source[upload:end])
        self.assertIn('image: ${NOW_TEST_IMAGE:?Set NOW_TEST_IMAGE to the loaded development image tag}', text('compose.test.yaml'))
        self.assertIn('    pull_policy: never\n', text('compose.test.yaml'))

    def test_ci_and_make_do_not_pin_stale_version_or_household_scripts(self):
        for path in ['Makefile', '.github/workflows/ci.yml', '.github/workflows/release.yml']:
            source = text(path)
            with self.subTest(path=path):
                self.assertNotIn('docky', source.lower())
                self.assertNotIn('VERSION=1.0.2', source)
                self.assertIn('scripts/test-release-consistency.py', source)
                self.assertIn('scripts/test-latest-image.py', source)

    def test_public_snapshot_excludes_household_deployments(self):
        self.assertFalse((ROOT / 'ops').exists())
        self.assertFalse((ROOT / 'docs/archive').exists())
        self.assertEqual(list((ROOT / 'scripts').glob('*docky*')), [])
        self.assertTrue((ROOT / 'LICENSE').is_file())
        self.assertTrue((ROOT / 'THIRD_PARTY_NOTICES.md').is_file())
        self.assertTrue((ROOT / 'PROVENANCE.md').is_file())

    def test_markdown_local_links_point_to_existing_files(self):
        paths = list(ROOT.glob('*.md')) + list(ROOT.glob('docs/**/*.md'))
        for path in paths:
            for target in re.findall(r'\]\(([^\s)]+)\)', path.read_text()):
                if '://' in target or target.startswith(('#', 'mailto:')):
                    continue
                target = target.split('#')[0]
                with self.subTest(path=str(path.relative_to(ROOT)), target=target):
                    self.assertTrue((path.parent / target).exists(), target)

    def test_current_installation_zip_has_complete_customer_links(self):
        with tempfile.TemporaryDirectory() as directory:
            staging = pathlib.Path(directory)
            packaging.prepare(ROOT, self.version, staging / 'assets', staging / 'release-body.md')
            archive = staging / 'assets' / f'watch-now-{self.version}-install.zip'
            packaging.verify_installation(archive)
            with zipfile.ZipFile(archive) as package:
                self.assertTrue({'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'PROVENANCE.md'} <= set(package.namelist()))
                self.assertFalse(any(name.startswith(('frontend/', 'internal/', 'ops/', '.git/')) for name in package.namelist()))

    def test_runtime_settings_and_legacy_browser_state_are_preserved(self):
        # Internal legacy keys avoid a surprise preferences reset. They are not branding.
        self.assertIn('dispatcharr_now_session', text('internal/httpapi/server.go'))
        self.assertIn('dispatcharr-now-appearance', text('frontend/src/appearance.js'))
        self.assertIn('dispatcharr-now-vlc-explained', text('frontend/src/components/WatchControl.jsx'))
        self.assertIn('${NOW_HOST_PORT:-9192}:8080', text('compose.yaml'))
        self.assertIn('${NOW_HOST_BIND:-127.0.0.1}', text('compose.yaml'))


class ReleasePackagingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name) / 'source'
        self.root.mkdir()
        for name in packaging.ROOT_FILES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('# Public file\n')
        (self.root / 'README.md').write_text('[Support](SUPPORT.md) [Guide](docs/guide.md)\n![Screen](docs/images/screen.png)\n')
        (self.root / 'RELEASE_NOTES.md').write_text('# Release notes\n\n## 1.4.0 — Customer improvements\n\nNew recording controls. [Guide](docs/guide.md)\n\n## 1.3.1 — Prior release\n\nOlder release.\n')
        (self.root / 'docs/images').mkdir(parents=True)
        (self.root / 'docs/guide.md').write_text('[README](../README.md) [Notices](../THIRD_PARTY_NOTICES.md)\n![Screenshot](images/screen.png)\n')
        (self.root / 'docs/images/screen.png').write_bytes(b'synthetic-image')
        # Neither application source nor local deployment secrets belong in install assets.
        (self.root / 'frontend').mkdir()
        (self.root / 'frontend/private-source.js').write_text('application source')
        (self.root / '.env').write_text('PRIVATE_TEST_SECRET=never-package')
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True)
        subprocess.run(['git', 'add', *sorted(packaging.ROOT_FILES), 'docs', 'frontend'], cwd=self.root, check=True)
        env = dict(os.environ, GIT_AUTHOR_DATE='2020-01-01T00:00:00Z', GIT_COMMITTER_DATE='2020-01-01T00:00:00Z')
        subprocess.run(['git', '-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid',
                        'commit', '-qm', 'Synthetic public package'], cwd=self.root, env=env, check=True)

    def prepare(self, name='release'):
        output = pathlib.Path(self.directory.name) / name
        notes = pathlib.Path(self.directory.name) / (name + '-body.md')
        packaging.prepare(self.root, '1.4.0', output, notes)
        return output, notes

    def test_deterministic_installation_and_source_assets_include_link_closure(self):
        first, notes = self.prepare('first')
        second, _ = self.prepare('second')
        for name in ['watch-now-1.4.0-install.zip', 'watch-now-1.4.0.tar.gz']:
            self.assertEqual((first / name).read_bytes(), (second / name).read_bytes())
        with zipfile.ZipFile(first / 'watch-now-1.4.0-install.zip') as archive:
            self.assertEqual(set(archive.namelist()), packaging.ROOT_FILES | {'docs/guide.md', 'docs/images/screen.png'})
            self.assertNotIn('.env', archive.namelist())
            self.assertNotIn('frontend/private-source.js', archive.namelist())
            self.assertNotIn('never-package', b''.join(archive.read(name) for name in archive.namelist()).decode(errors='ignore'))
        packaging.verify_installation(first / 'watch-now-1.4.0-install.zip')
        self.assertIn('Customer improvements', notes.read_text())
        self.assertIn('https://github.com/JermZone/watch-now/blob/v1.4.0/docs/guide.md', notes.read_text())
        self.assertNotIn('Older release.', notes.read_text())

    def test_missing_packaged_link_stops_preparation(self):
        (self.root / 'docs/guide.md').write_text('[Missing source](../internal/private.go)')
        with self.assertRaisesRegex(ValueError, 'Broken packaged link'):
            self.prepare()

    def test_reference_and_encoded_local_links_are_checked_after_extraction(self):
        (self.root / 'docs/guide.md').write_text('[Good][guide]\n[guide]: ../README.md#title\n')
        self.prepare('good')
        (self.root / 'docs/guide.md').write_text('[Missing](images/missing%20screen.png)')
        with self.assertRaisesRegex(ValueError, 'Broken packaged link'):
            self.prepare('bad')

    def test_local_link_cannot_escape_installation_root(self):
        (self.root / 'docs/guide.md').write_text('[Outside](../../source/README.md)')
        with self.assertRaisesRegex(ValueError, 'Broken packaged link'):
            self.prepare()

    def test_tracked_private_document_type_or_symlink_is_rejected(self):
        key = self.root / 'docs/private.pem'
        key.write_text('not-public')
        subprocess.run(['git', 'add', 'docs/private.pem'], cwd=self.root, check=True)
        with self.assertRaisesRegex(ValueError, 'Unexpected file'):
            packaging.installation_files(self.root)
        subprocess.run(['git', 'rm', '-f', 'docs/private.pem'], cwd=self.root, check=True, stdout=subprocess.DEVNULL)
        (self.root / 'docs/guide.md').unlink()
        (self.root / 'docs/guide.md').symlink_to('../.env')
        with self.assertRaisesRegex(ValueError, 'regular public files'):
            packaging.installation_files(self.root)

    def test_only_one_nonempty_exact_version_section_is_allowed(self):
        invalid = ['## 1.3.1\nOld.', '## 1.4.0-rc.1\nCandidate.', '## 1.4.0\n',
                   '## 1.4.0\nFirst.\n## 1.4.0\nSecond.']
        for notes in invalid:
            with self.subTest(notes=notes), self.assertRaises(ValueError):
                packaging.release_body(notes, '1.4.0')
        self.assertIn('Candidate.', packaging.release_body('## 1.4.0-rc.1\nCandidate.', '1.4.0-rc.1'))

    def test_recorded_digest_and_checksums_match_checked_assets(self):
        output, _ = self.prepare()
        digest = 'sha256:' + 'a' * 64
        packaging.finalize(output, '1.4.0', digest)
        self.assertEqual((output / 'image-digest.txt').read_text(), packaging.IMAGE + '@' + digest + '\n')
        checksums = (output / 'SHA256SUMS').read_text().splitlines()
        self.assertEqual(len(checksums), 3)
        for line in checksums:
            checksum, name = line.split('  ')
            self.assertEqual(checksum, hashlib.sha256((output / name).read_bytes()).hexdigest())
        with self.assertRaisesRegex(ValueError, 'replace finalized'):
            packaging.finalize(output, '1.4.0', 'sha256:' + 'b' * 64)

    def test_finalize_rejects_missing_assets_or_non_digest_image(self):
        output, notes = self.prepare()
        for digest in ['latest', 'ghcr.io/jermzone/watch-now:1.4.0', 'sha256:bad']:
            with self.subTest(digest=digest), self.assertRaises(ValueError):
                packaging.finalize(output, '1.4.0', digest)
        (output / 'watch-now-1.4.0.tar.gz').unlink()
        with self.assertRaisesRegex(ValueError, 'packages must exist'):
            packaging.finalize(output, '1.4.0', 'sha256:' + 'a' * 64)
        with self.assertRaisesRegex(ValueError, 'staging paths must be empty'):
            packaging.prepare(self.root, '1.4.0', output, notes)


class ImmutableReleaseTargetTests(unittest.TestCase):
    def verify(self, responses, tag='v1.4.0'):
        requests = []
        def request(url, headers):
            requests.append((url, headers))
            return responses[len(requests) - 1]
        safety.check_target(tag, 'synthetic-token', 'synthetic-actor', request)
        return requests

    def absent(self):
        return [(200, {}), (404, {'message': 'Not Found'}), (200, {'token': 'registry-token'}),
                (404, {'errors': [{'code': 'MANIFEST_UNKNOWN'}]})]

    def test_only_confirmed_absence_allows_stable_or_rc_publication(self):
        for tag in ['v1.4.0', 'v1.4.1-rc.1']:
            requests = self.verify(self.absent(), tag)
            self.assertTrue(requests[-1][0].endswith('/manifests/' + tag[1:]))
            self.assertEqual(requests[-1][1]['Authorization'], 'Bearer registry-token')
        responses = self.absent()
        responses[-1] = (404, {'errors': [{'code': 'NAME_UNKNOWN'}]})
        self.verify(responses)

    def test_existing_github_release_including_draft_is_never_replaced(self):
        for release in [{'draft': True}, {'draft': False}, {}]:
            with self.subTest(release=release), self.assertRaisesRegex(safety.ReleaseSafetyError, 'already exists'):
                self.verify([(200, {}), (200, release)])

    def test_existing_image_from_partial_publication_cannot_be_reused(self):
        responses = self.absent()
        responses[-1] = (200, {'schemaVersion': 2})
        with self.assertRaisesRegex(safety.ReleaseSafetyError, 'partial prior publication'):
            self.verify(responses)

    def test_github_access_or_rate_limit_failures_never_count_as_absence(self):
        for index, status in [(0, 401), (0, 404), (0, 503), (1, 401), (1, 403), (1, 429), (1, 503)]:
            responses = self.absent()
            responses[index] = (status, {'message': 'synthetic error'})
            with self.subTest(index=index, status=status), self.assertRaises(safety.ReleaseSafetyError):
                self.verify(responses)

    def test_registry_auth_or_unexpected_manifest_errors_fail_closed(self):
        for index, response in [(2, (401, {})), (2, (200, {})), (2, (200, {'token': ''})),
                                (3, (401, {'errors': [{'code': 'UNAUTHORIZED'}]})),
                                (3, (503, {})), (3, (404, {})),
                                (3, (404, {'errors': [{'code': 'DENIED'}]})),
                                (3, (404, {'errors': [{'code': 'MANIFEST_UNKNOWN'}, {'code': 'DENIED'}]}))]:
            responses = self.absent()
            responses[index] = response
            with self.subTest(index=index, response=response), self.assertRaises(safety.ReleaseSafetyError):
                self.verify(responses)

    def test_missing_auth_or_malformed_tag_cannot_query_or_publish(self):
        for tag, token, actor in [('v01.4.0', 'token', 'actor'), ('v1.4.0-rc.0', 'token', 'actor'),
                                  ('v1.4.0', '', 'actor'), ('v1.4.0', 'token', '')]:
            with self.subTest(tag=tag), self.assertRaises(safety.ReleaseSafetyError):
                safety.check_target(tag, token, actor, mock.Mock(side_effect=AssertionError('Must not query')))

    def test_network_exception_does_not_expose_authentication_material(self):
        with mock.patch.object(safety.urllib.request, 'urlopen', side_effect=urllib.error.URLError('private-token')):
            with self.assertRaises(safety.ReleaseSafetyError) as caught:
                safety.request_json('https://example.invalid', {'Authorization': 'Bearer private-token'})
        self.assertNotIn('private-token', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
