import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildSnapshot,
  fetchAllReleases,
  renderHistoryCsv,
  renderMetricsReadme,
  writeMetrics,
} from './collect-release-metrics.mjs';

const repository = 'Ray25010/Frame-Cull-AI';

function release({
  id,
  tag,
  name = tag,
  draft = false,
  prerelease = false,
  publishedAt = '2026-07-12T00:00:00Z',
  assets = [],
}) {
  return {
    id,
    tag_name: tag,
    name,
    draft,
    prerelease,
    published_at: publishedAt,
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
    assets,
  };
}

function asset({ id, name, downloads, size = 1024 }) {
  return {
    id,
    name,
    size,
    download_count: downloads,
    updated_at: '2026-07-12T00:00:00Z',
    browser_download_url: `https://github.com/${repository}/releases/download/test/${name}`,
  };
}

test('buildSnapshot excludes drafts and totals published release assets', () => {
  const snapshot = buildSnapshot({
    repository,
    capturedAt: '2026-07-12T16:17:00Z',
    releases: [
      release({
        id: 2,
        tag: 'v2',
        prerelease: true,
        assets: [
          asset({ id: 22, name: 'FrameCull-x64.zip', downloads: 2 }),
          asset({ id: 21, name: 'FrameCull-arm64.zip', downloads: 6 }),
        ],
      }),
      release({
        id: 1,
        tag: 'draft-v1',
        draft: true,
        assets: [asset({ id: 11, name: 'draft.zip', downloads: 99 })],
      }),
    ],
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.date, '2026-07-12');
  assert.deepEqual(snapshot.totals, {
    releaseCount: 1,
    assetCount: 2,
    currentDownloads: 8,
    downloadIncrease: 8,
  });
  assert.deepEqual(
    snapshot.releases[0].assets.map((entry) => entry.name),
    ['FrameCull-arm64.zip', 'FrameCull-x64.zip'],
  );
  assert.ok(snapshot.releases[0].assets.every((entry) => entry.trackingState === 'new'));
});

test('buildSnapshot distinguishes existing, replaced, and new assets', () => {
  const previousSnapshot = buildSnapshot({
    repository,
    capturedAt: '2026-07-11T16:17:00Z',
    releases: [
      release({
        id: 2,
        tag: 'v2',
        assets: [
          asset({ id: 21, name: 'FrameCull-arm64.zip', downloads: 4 }),
          asset({ id: 22, name: 'FrameCull-x64.zip', downloads: 10 }),
        ],
      }),
    ],
  });

  const snapshot = buildSnapshot({
    repository,
    capturedAt: '2026-07-12T16:17:00Z',
    previousSnapshot,
    releases: [
      release({
        id: 2,
        tag: 'v2',
        assets: [
          asset({ id: 21, name: 'FrameCull-arm64.zip', downloads: 6 }),
          asset({ id: 23, name: 'FrameCull-x64.zip', downloads: 1 }),
          asset({ id: 24, name: 'checksums.txt', downloads: 3 }),
        ],
      }),
    ],
  });

  const byName = Object.fromEntries(
    snapshot.releases[0].assets.map((entry) => [entry.name, entry]),
  );
  assert.deepEqual(
    {
      state: byName['FrameCull-arm64.zip'].trackingState,
      delta: byName['FrameCull-arm64.zip'].downloadDelta,
    },
    { state: 'existing', delta: 2 },
  );
  assert.deepEqual(
    {
      state: byName['FrameCull-x64.zip'].trackingState,
      delta: byName['FrameCull-x64.zip'].downloadDelta,
      previousAssetId: byName['FrameCull-x64.zip'].previousAssetId,
    },
    { state: 'replaced', delta: 1, previousAssetId: 22 },
  );
  assert.deepEqual(
    {
      state: byName['checksums.txt'].trackingState,
      delta: byName['checksums.txt'].downloadDelta,
    },
    { state: 'new', delta: 3 },
  );
  assert.equal(snapshot.totals.downloadIncrease, 6);
});

test('renderHistoryCsv rebuilds deterministic rows from one snapshot per day', () => {
  const first = buildSnapshot({
    repository,
    capturedAt: '2026-07-11T16:17:00Z',
    releases: [
      release({
        id: 2,
        tag: 'v2',
        name: 'FrameCull, Test',
        assets: [asset({ id: 21, name: 'FrameCull-arm64.zip', downloads: 4 })],
      }),
    ],
  });
  const second = buildSnapshot({
    repository,
    capturedAt: '2026-07-12T16:17:00Z',
    previousSnapshot: first,
    releases: [
      release({
        id: 2,
        tag: 'v2',
        name: 'FrameCull, Test',
        assets: [asset({ id: 21, name: 'FrameCull-arm64.zip', downloads: 6 })],
      }),
    ],
  });

  const csv = renderHistoryCsv([second, first]);
  const lines = csv.trimEnd().split('\n');

  assert.equal(lines.length, 3);
  assert.match(lines[0], /^date,captured_at,release_tag,/);
  assert.match(lines[1], /^2026-07-11,/);
  assert.match(lines[2], /^2026-07-12,/);
  assert.match(lines[2], /,"FrameCull, Test",/);
  assert.match(lines[2], /,6,2,existing$/);
});

test('fetchAllReleases follows GitHub pagination without exposing the token', async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    const isFirstPage = new URL(url).searchParams.get('page') === '1';
    return new Response(
      JSON.stringify(isFirstPage
        ? [release({ id: 1, tag: 'v1' })]
        : [release({ id: 2, tag: 'v2' })]),
      {
        status: 200,
        headers: isFirstPage
          ? { link: `<https://api.github.com/repos/${repository}/releases?per_page=100&page=2>; rel="next"` }
          : {},
      },
    );
  };

  const releases = await fetchAllReleases({
    repository,
    token: 'secret-token',
    request,
  });

  assert.deepEqual(releases.map((entry) => entry.tag_name), ['v1', 'v2']);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token');
  assert.ok(!requests[0].url.includes('secret-token'));
});

test('writeMetrics overwrites a same-day snapshot and uses it for the next-day delta', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'framecull-release-metrics-'));
  const releasesWithDownloads = (downloads) => [
    release({
      id: 2,
      tag: 'v2',
      assets: [asset({ id: 21, name: 'FrameCull-arm64.zip', downloads })],
    }),
  ];

  try {
    await writeMetrics({
      outputDir,
      repository,
      capturedAt: '2026-07-12T16:17:00Z',
      releases: releasesWithDownloads(4),
    });
    await writeMetrics({
      outputDir,
      repository,
      capturedAt: '2026-07-12T18:00:00Z',
      releases: releasesWithDownloads(5),
    });
    const nextDay = await writeMetrics({
      outputDir,
      repository,
      capturedAt: '2026-07-13T16:17:00Z',
      releases: releasesWithDownloads(6),
    });

    const firstDay = JSON.parse(
      await readFile(join(outputDir, 'snapshots', '2026-07-12.json'), 'utf8'),
    );
    const latest = JSON.parse(await readFile(join(outputDir, 'latest.json'), 'utf8'));
    const csv = await readFile(join(outputDir, 'release-downloads.csv'), 'utf8');

    assert.equal(firstDay.capturedAt, '2026-07-12T18:00:00.000Z');
    assert.equal(firstDay.releases[0].assets[0].downloadCount, 5);
    assert.equal(nextDay.releases[0].assets[0].downloadDelta, 1);
    assert.equal(latest.date, '2026-07-13');
    assert.equal(csv.trimEnd().split('\n').length, 3);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('renderMetricsReadme presents totals, asset rows, and the unique-user limitation', () => {
  const snapshot = buildSnapshot({
    repository,
    capturedAt: '2026-07-12T16:17:00Z',
    releases: [
      release({
        id: 2,
        tag: 'macos-test',
        name: 'FrameCull macOS',
        prerelease: true,
        assets: [asset({ id: 21, name: 'FrameCull-arm64.zip', downloads: 6 })],
      }),
    ],
  });

  const markdown = renderMetricsReadme(snapshot);

  assert.match(markdown, /当前资产累计下载次数：\*\*6\*\*/);
  assert.match(markdown, /本次记录新增下载次数：\*\*6\*\*/);
  assert.match(markdown, /\| macos-test \| FrameCull-arm64\.zip \| 6 \| \+6 \| new \|/);
  assert.match(markdown, /下载次数不等于独立用户数/);
});
