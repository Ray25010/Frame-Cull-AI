# GitHub Release 下载统计

FrameCull AI 使用 GitHub Actions 每日记录公开 Release 资产的下载次数，不修改客户端，也不采集用户设备或照片信息。

## 自动运行

- Workflow：`.github/workflows/release-download-metrics.yml`
- 定时：每天 `00:17 UTC`，即北京时间 `08:17`
- 手动运行：GitHub 仓库的 **Actions → Record release download metrics → Run workflow**
- 权限：只使用仓库自带的 `GITHUB_TOKEN`，无需保存个人令牌或新增 Secret

Workflow 从 GitHub Releases API 读取所有已发布 Release，排除 draft，然后把结果提交到独立的 `metrics` 分支。首次运行会自动创建该分支。

## 生成文件

`metrics` 分支包含：

- `README.md`：最新累计下载量、当日增量和逐资产表格
- `latest.json`：最新机器可读快照
- `release-downloads.csv`：每日逐资产历史，可直接用 Excel 打开
- `snapshots/YYYY-MM-DD.json`：每日完整原始快照

同一天重复运行会覆盖当天快照，并从全部快照重新生成 CSV，不会重复追加同一天的数据。

## 指标口径

- `downloadCount`：GitHub 当前返回的资产累计下载次数
- `downloadDelta`：与上一日快照相比的新增下载次数
- `existing`：asset ID 未变化
- `new`：首次发现该资产
- `replaced`：同一 Release tag 下的同名资产被删除并重新上传，asset ID 已变化

删除并重新上传资产会让 GitHub 原生下载计数从零开始。每日快照会保留替换前数据，并把新 asset ID 标记为 `replaced`，从而避免历史证据丢失。

## 限制

GitHub Release 下载次数不是独立用户数：同一用户重复下载会重复计数，GitHub 也不向仓库维护者提供下载者身份或唯一 IP。这个阶段只能回答“安装包被下载了多少次”，不能回答“有多少真实安装用户”或 DAU/MAU。

## 本地测试

```powershell
node --test tools/release-metrics/collect-release-metrics.test.mjs

$env:GITHUB_REPOSITORY = 'Ray25010/Frame-Cull-AI'
$env:GITHUB_TOKEN = gh auth token
$env:METRICS_OUTPUT_DIR = Join-Path $env:TEMP 'framecull-release-metrics'
node tools/release-metrics/collect-release-metrics.mjs
Remove-Item Env:GITHUB_TOKEN
```

本地运行结果写入临时目录，不要把令牌写入配置、README、JSON 或 CSV。
