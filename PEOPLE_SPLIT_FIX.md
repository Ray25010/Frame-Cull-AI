# 人物分片卡顿问题修复

## 问题描述
人物分片功能在"正在分析当前批次"的最后阶段（99%）会卡住整整1分钟，期间整个页面无响应。

## 根本原因
`clusterPeopleFaces()` 聚类算法在主线程同步执行，复杂度为 O(n²) 甚至更高。当人脸数量较多时（如 414 张照片可能产生数百上千张人脸），会阻塞主线程导致 UI 冻结。

核心问题代码位于 `src/hooks/usePeopleSplit.ts:260`：
```typescript
const clustered = clusterPeopleFaces(allFaces); // 主线程阻塞！
```

## 解决方案
将聚类计算从主线程迁移到 Web Worker 中异步执行。

### 代码变更

#### 1. Worker 端 (`src/workers/peopleSplit.worker.ts`)
- 新增 `ClusterPeopleRequest` 和 `ClusterPeopleResponse` 类型
- 在消息处理器中添加 `type === 'cluster'` 分支
- 导入 `clusterPeopleFaces` 函数并在 worker 中执行
- 添加 `postClusterProgress()` 函数报告进度

#### 2. 主线程端 (`src/hooks/usePeopleSplit.ts`)
- 新增 `clusterPeopleFacesInWorker()` 函数，封装 worker 通信逻辑
- 修改聚类调用从同步改为异步：
  ```typescript
  const clustered = await clusterPeopleFacesInWorker(workers[0], allFaces, (stage) => {
    setState(prev => ({ ...prev, currentStage: stage }));
  });
  ```
- 设置 2 分钟超时保护

## 效果
- ✅ 主线程不再阻塞，UI 保持响应
- ✅ 用户可以看到实时进度更新（"生成分组"等）
- ✅ 大批量照片处理时页面不会冻结
- ✅ 保持原有聚类算法逻辑不变

## 测试建议
1. 导入 400+ 张照片运行人物分片
2. 观察 99% 阶段是否还会卡住
3. 确认页面始终可交互（鼠标悬停、滚动等）
4. 验证最终聚类结果与之前一致

## 技术细节
- Worker 通信采用 Promise 封装，简化异步调用
- 保留进度回调机制，用户体验更好
- 超时设置为 120 秒，适应大数据集场景
- 复用现有 worker 池，无需创建新 worker

修复日期：2026-07-08
