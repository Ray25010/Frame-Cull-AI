import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function logicalAssetKey(tagName, assetName) {
  return `${tagName}\u0000${assetName}`;
}

function previousAssetIndexes(previousSnapshot) {
  const byId = new Map();
  const byLogicalKey = new Map();

  for (const release of previousSnapshot?.releases ?? []) {
    for (const asset of release.assets ?? []) {
      byId.set(String(asset.id), asset);
      byLogicalKey.set(logicalAssetKey(release.tagName, asset.name), asset);
    }
  }

  return { byId, byLogicalKey };
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

export function buildSnapshot({
  repository,
  capturedAt,
  releases,
  previousSnapshot = null,
}) {
  const parsedCapturedAt = new Date(capturedAt);
  if (!repository || Number.isNaN(parsedCapturedAt.getTime())) {
    throw new Error('repository and a valid capturedAt timestamp are required');
  }

  const normalizedCapturedAt = parsedCapturedAt.toISOString();
  const previous = previousAssetIndexes(previousSnapshot);
  const publishedReleases = (releases ?? [])
    .filter((release) => !release.draft)
    .map((release) => {
      const tagName = String(release.tag_name ?? '');
      const assets = (release.assets ?? [])
        .map((asset) => {
          const id = asset.id;
          const name = String(asset.name ?? '');
          const downloadCount = nonNegativeInteger(asset.download_count);
          const previousById = previous.byId.get(String(id));
          const previousByName = previous.byLogicalKey.get(logicalAssetKey(tagName, name));

          let trackingState = 'new';
          let downloadDelta = downloadCount;
          let previousAssetId = null;

          if (previousById) {
            trackingState = 'existing';
            downloadDelta = Math.max(0, downloadCount - nonNegativeInteger(previousById.downloadCount));
          } else if (previousByName) {
            trackingState = 'replaced';
            previousAssetId = previousByName.id;
          }

          return {
            id,
            name,
            sizeBytes: nonNegativeInteger(asset.size),
            downloadCount,
            downloadDelta,
            trackingState,
            previousAssetId,
            updatedAt: asset.updated_at ?? null,
            downloadUrl: asset.browser_download_url ?? null,
          };
        })
        .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));

      return {
        id: release.id,
        tagName,
        name: String(release.name || tagName),
        prerelease: Boolean(release.prerelease),
        publishedAt: release.published_at ?? null,
        releaseUrl: release.html_url ?? null,
        assets,
      };
    })
    .sort((left, right) => compareText(left.tagName, right.tagName));

  const allAssets = publishedReleases.flatMap((release) => release.assets);

  return {
    schemaVersion: 1,
    repository,
    capturedAt: normalizedCapturedAt,
    date: normalizedCapturedAt.slice(0, 10),
    previousDate: previousSnapshot?.date ?? null,
    totals: {
      releaseCount: publishedReleases.length,
      assetCount: allAssets.length,
      currentDownloads: allAssets.reduce((sum, asset) => sum + asset.downloadCount, 0),
      downloadIncrease: allAssets.reduce((sum, asset) => sum + asset.downloadDelta, 0),
    },
    releases: publishedReleases,
  };
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderHistoryCsv(snapshots) {
  const latestByDate = new Map();
  for (const snapshot of snapshots ?? []) {
    const existing = latestByDate.get(snapshot.date);
    if (!existing || snapshot.capturedAt > existing.capturedAt) {
      latestByDate.set(snapshot.date, snapshot);
    }
  }

  const rows = [[
    'date',
    'captured_at',
    'release_tag',
    'release_name',
    'is_prerelease',
    'asset_id',
    'asset_name',
    'size_bytes',
    'download_count',
    'download_delta',
    'tracking_state',
  ]];

  const orderedSnapshots = [...latestByDate.values()]
    .sort((left, right) => compareText(left.capturedAt, right.capturedAt));

  for (const snapshot of orderedSnapshots) {
    for (const release of snapshot.releases) {
      for (const asset of release.assets) {
        rows.push([
          snapshot.date,
          snapshot.capturedAt,
          release.tagName,
          release.name,
          release.prerelease,
          asset.id,
          asset.name,
          asset.sizeBytes,
          asset.downloadCount,
          asset.downloadDelta,
          asset.trackingState,
        ]);
      }
    }
  }

  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

export async function fetchAllReleases({
  repository,
  token = '',
  request = fetch,
}) {
  const [owner, name, extra] = String(repository ?? '').split('/');
  if (!owner || !name || extra) {
    throw new Error('repository must use the owner/name format');
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'framecull-release-metrics',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const releases = [];
  let url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=100&page=1`;

  while (url) {
    const response = await request(url, { headers });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`GitHub Releases API returned ${response.status}: ${detail.slice(0, 500)}`);
    }

    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new Error('GitHub Releases API returned a non-array response');
    }
    releases.push(...page);

    const link = response.headers.get('link') ?? '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/i);
    url = next?.[1] ?? '';
  }

  return releases;
}

async function readSnapshots(snapshotDir) {
  let entries;
  try {
    entries = await readdir(snapshotDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) {
      continue;
    }
    snapshots.push(JSON.parse(await readFile(join(snapshotDir, entry.name), 'utf8')));
  }
  return snapshots;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeMetrics({
  outputDir,
  repository,
  capturedAt,
  releases,
}) {
  const snapshotDir = join(outputDir, 'snapshots');
  await mkdir(snapshotDir, { recursive: true });

  const captureDate = new Date(capturedAt).toISOString().slice(0, 10);
  const existingSnapshots = await readSnapshots(snapshotDir);
  const previousSnapshot = existingSnapshots
    .filter((snapshot) => snapshot.date < captureDate)
    .sort((left, right) => compareText(right.capturedAt, left.capturedAt))[0] ?? null;

  const snapshot = buildSnapshot({
    repository,
    capturedAt,
    releases,
    previousSnapshot,
  });
  await writeJson(join(snapshotDir, `${snapshot.date}.json`), snapshot);

  const allSnapshots = await readSnapshots(snapshotDir);
  await writeJson(join(outputDir, 'latest.json'), snapshot);
  await writeFile(join(outputDir, 'README.md'), renderMetricsReadme(snapshot), 'utf8');
  await writeFile(
    join(outputDir, 'release-downloads.csv'),
    renderHistoryCsv(allSnapshots),
    'utf8',
  );

  return snapshot;
}

function markdownCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll(/\r?\n/g, ' ');
}

export function renderMetricsReadme(snapshot) {
  const rows = [];
  for (const release of snapshot.releases) {
    for (const asset of release.assets) {
      rows.push(
        `| ${markdownCell(release.tagName)} | ${markdownCell(asset.name)} | ${asset.downloadCount} | +${asset.downloadDelta} | ${asset.trackingState} |`,
      );
    }
  }

  return `# FrameCull AI Release 下载统计

> 此分支由 GitHub Actions 每日自动更新，请勿手工修改生成文件。

- 仓库：\`${snapshot.repository}\`
- 统计日期：\`${snapshot.date}\`
- 采集时间：\`${snapshot.capturedAt}\`
- 当前资产累计下载次数：**${snapshot.totals.currentDownloads}**
- 本次记录新增下载次数：**${snapshot.totals.downloadIncrease}**

| Release tag | 资产 | 累计下载 | 本次新增 | 状态 |
| --- | --- | ---: | ---: | --- |
${rows.join('\n')}

## 数据说明

- GitHub 的下载次数不等于独立用户数；同一用户重复下载会重复计数。
- 只统计已发布 Release 的上传资产，不统计草稿 Release 和自动生成的源码压缩包。
- \`existing\` 表示同一 asset ID 的正常增量，\`new\` 表示首次发现，\`replaced\` 表示同名资产被删除后重新上传。
- 每日原始快照位于 \`snapshots/\`，完整历史位于 \`release-downloads.csv\`，最新机器可读数据位于 \`latest.json\`。
`;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const outputDir = resolve(process.env.METRICS_OUTPUT_DIR || 'metrics-data');
  const capturedAt = process.env.METRICS_CAPTURED_AT || new Date().toISOString();

  if (!repository || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  }

  const releases = await fetchAllReleases({ repository, token });
  const snapshot = await writeMetrics({
    outputDir,
    repository,
    capturedAt,
    releases,
  });
  console.log(JSON.stringify({
    repository,
    date: snapshot.date,
    outputDir,
    totals: snapshot.totals,
  }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
