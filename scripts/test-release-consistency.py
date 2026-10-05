#!/usr/bin/env python3
"""Offline checks for canonical branding, version metadata, and public packaging."""
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def text(path):
    return (ROOT / path).read_text(encoding='utf-8')


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
        self.assertIn('watch-now-$VERSION.tar.gz', text('.github/workflows/release.yml'))
        self.assertIn('docs/dvr.md docs/tv-guide.md release/install/docs/', text('.github/workflows/release.yml'))
        self.assertIn('compose.dvr.yaml compose.dvr-master.yaml release/install/', text('.github/workflows/release.yml'))

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

    def test_runtime_settings_and_legacy_browser_state_are_preserved(self):
        # Internal legacy keys avoid a surprise preferences reset. They are not branding.
        self.assertIn('dispatcharr_now_session', text('internal/httpapi/server.go'))
        self.assertIn('dispatcharr-now-appearance', text('frontend/src/appearance.js'))
        self.assertIn('dispatcharr-now-vlc-explained', text('frontend/src/components/WatchControl.jsx'))
        self.assertIn('${NOW_HOST_PORT:-9192}:8080', text('compose.yaml'))
        self.assertIn('${NOW_HOST_BIND:-127.0.0.1}', text('compose.yaml'))


if __name__ == '__main__':
    unittest.main()
