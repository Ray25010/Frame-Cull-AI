# FrameCull AI Liquid Glass UI Refactor Plan

## Summary

目标是把 FrameCull AI 的界面升级成更接近 iOS / macOS 新材料语言的轻量 Liquid Glass 风格，但不牺牲筛图效率。FrameCull 是摄影师工作台，不是展示页，所以这次的核心不是炫技，而是把现有 toolbar、viewer controls、AI 浮窗、设置页、RAW 监看状态做得更高级、更统一、更稳定。

本方案只规划前端视觉系统和可回退开发流程，不改 AI 筛片算法、不改 RAW 解码链路、不改 Flash / Pro 版本边界。

## Current Evidence

- 当前分支：`codex/apple-ui-redesign`
- 项目已有 `PRODUCT.md`，register 是 `product`
- 项目没有既有 `DESIGN.md`，本轮已新增根目录 `DESIGN.md`
- 当前已有 glass helper：`src/components/ui/chrome.ts`
- 当前主要 UI 文件：
  - `src/App.tsx`
  - `src/index.css`
  - `src/components/Toolbar.tsx`
  - `src/components/Viewer.tsx`
  - `src/components/AiFloatingPanel.tsx`
  - `src/components/SettingsPanel.tsx`
  - `src/components/ui/chrome.ts`
- 已保存改动前状态快照：
  - `output/ui-redesign-preflight/status-before-plan.txt`
  - `output/ui-redesign-preflight/diff-stat-before-plan.txt`

## References Used

### Official / Primary

- Apple Developer: Liquid Glass
  https://developer.apple.com/documentation/technologyoverviews/liquid-glass
- Apple HIG: Materials
  https://developer.apple.com/design/human-interface-guidelines/materials
- WWDC: Meet Liquid Glass
  https://developer.apple.com/videos/play/wwdc2025/219/

### Open Source / Practical

- `rdev/liquid-glass-react`
  https://github.com/rdev/liquid-glass-react
- `VoltAgent/awesome-design-md`
  https://github.com/VoltAgent/awesome-design-md

### Inspiration Sites

- Landbook: restrained premium web references
- Awwwards: motion and atmosphere references
- One Page Love: concise page composition references
- landing.love: interaction and transition references
- Mobbin: app flow and product UI references
- Lapa Ninja: visual treatment references
- Framer Gallery: polished motion references
- Aceternity UI: component inspiration, not direct product dependency
- 21st: template pattern reference, not direct adoption
- siteinspire: high-level mood and composition reference

## Important Design Decision

`liquid-glass-react` is useful as a lab reference, but should not enter the default production path yet.

Reason:

1. FrameCull is a Tauri photo workstation, not a marketing page.
2. The library adds refraction, elasticity, chromatic aberration, and mouse response. These can distract from photo review.
3. GitHub README notes Safari and Firefox have partial support for displacement. Tauri WebView must be measured before adopting it.
4. The repo has no releases published at inspection time, so the dependency risk is higher than a small local CSS material system.

Recommended path:

- Phase 1 to 3: implement our own CSS/Tailwind material tokens in `chrome.ts` and `index.css`.
- Phase 4: if desired, create an isolated lab route or dev-only component to compare `liquid-glass-react`.
- Production default: no new glass dependency until screenshot QA and culling speed tests prove no regression.

## Design Direction

Reading this as: dense desktop photo-culling product UI for working photographers, with restrained Apple-inspired material language, leaning toward Linear precision plus Raycast-style utility density.

Design dials:

- Design variance: 4 / 10
- Motion intensity: 3 / 10
- Visual density: 8 / 10

Interpretation:

- More refined than current UI, but not more decorative.
- Motion is for AI engine startup, RAW cache generation, active selection, and hover/focus feedback only.
- The photo stays dominant. Chrome recedes.

## What To Preserve

- Keyboard-driven review flow.
- Large image preview as the visual center.
- Existing Flash / Pro split.
- Existing local-only privacy positioning.
- Existing AI state vocabulary: review, clear, picked, rejected, duplicate, RAW monitor.
- Existing system font stack, because this is product UI and Chinese text needs reliability.
- Existing lucide icon dependency, because the app already uses it and mixing icon families would make the interface less consistent.

## What To Change

### 1. Tokenize Glass Instead Of Inline Styling

Current issue:

- Glass styling exists, but blur values and shadows are repeated across components.
- Some blur values are very high, for example `backdrop-blur-[72px]` and `backdrop-blur-[96px]`.
- Heavy blur on large surfaces risks UI cost and can make text feel soft.

Target:

- Replace scattered values with named material tokens:
  - `chromeSolid`
  - `chromeGlass`
  - `chromeActive`
  - `chromePopover`
  - `photoOverlay`
- Keep default blur between 24px and 40px.
- Use 70px+ blur only for small transient popovers if measured safe.

Files:

- `src/components/ui/chrome.ts`
- `src/index.css`

### 2. Make Toolbar A Quiet Control Plane

Current:

- Toolbar already has compact density and AI progress.
- It has strong glass and multiple inline surface treatments.

Target:

- One toolbar surface token.
- Stable center AI progress capsule.
- AI engine startup text can appear, but scanned count should not say model branding.
- Import/export/settings buttons use the same selected, hover, disabled, and focus vocabulary.

Files:

- `src/components/Toolbar.tsx`

### 3. Make Viewer Controls More Photographic

Current:

- Viewer bottom controls use glass and shadow.
- RAW monitor notices and cache states are present.

Target:

- Viewer photo area stays clean, no decorative glass on canvas.
- Bottom control bar becomes a small material plate, high contrast over bright photos.
- RAW monitor generation state gets clearer hierarchy:
  - current photo checking
  - generating cache
  - using embedded fallback
  - failed and cooled down
- Avoid blocking JPG fallback when RAW monitor cache is missing.

Files:

- `src/components/Viewer.tsx`
- `src/editions/useRawMonitorViewerFrame.pro.ts`

### 4. Rebuild AI Floating Panel As Engine HUD

Current:

- AI floating panel now has engine initialization text and progress.
- It is already glassy but can be more disciplined.

Target:

- Compact engine HUD, not a floating marketing card.
- Startup copy:
  - `AI 美学引擎启动中`
  - detail: `正在加载本地审美模型与筛片规则`
- Running state:
  - phase
  - processed / total
  - elapsed
  - remaining
  - pause / resume
- Keep Pro model scoring distinct from Flash AI analysis.

Files:

- `src/components/AiFloatingPanel.tsx`
- `src/hooks/useAiCulling.ts`

### 5. Settings Panel: Clearer Pro / Flash Separation

Current:

- Settings has product text, Pro model diagnostics, RAW engine controls, cache management.

Target:

- Settings sections should feel calm and scannable.
- Pro-only surfaces use `Pro` badge and diagnostics, not a separate visual universe.
- RAW monitor controls should clearly say what is cached and when it regenerates.
- Cache controls should be separated by scope:
  - AI analysis cache
  - RAW monitor preview cache
  - app preview cache

Files:

- `src/components/SettingsPanel.tsx`
- `src/editions/RawEngineSection.pro.tsx`

### 6. Filmstrip And Inspector Performance Guard

Current:

- Filmstrip and inspector are dense and scroll-heavy.

Target:

- Avoid backdrop blur on long scrolling containers.
- Use solid surfaces and hairline borders.
- Current image, AI issue, picked, rejected, duplicate, and RAW/JPG state must be visible at thumbnail scale.

Files:

- `src/components/Filmstrip.tsx`
- `src/components/Viewer.tsx`

## Refactor Phases

### Phase 0: Safety Checkpoint

Status: started.

Actions:

1. Keep work on `codex/apple-ui-redesign`.
2. Save preflight status and diff stats under `output/ui-redesign-preflight`.
3. Add `DESIGN.md` and this plan.
4. Do not touch algorithm, RAW engine, or worker code in UI phase.

Rollback:

- Documentation-only changes can be reverted by removing `DESIGN.md`, this plan, and `.agents/skills/awesome-design-md`.
- UI implementation phases should be separate commits or patch files.

### Phase 1: Material Token Layer

Actions:

1. Replace existing `glassSurface`, `glassPopover`, `glassInteractive`, `glassActive`, and `glassSubtle` with a richer but smaller token set.
2. Add CSS utility classes for:
   - `.fc-chrome-solid`
   - `.fc-chrome-glass`
   - `.fc-chrome-popover`
   - `.fc-photo-overlay`
   - `.fc-focus-ring`
3. Add reduced transparency fallback:
   - if supported, use `@media (prefers-reduced-transparency: reduce)`
   - otherwise keep a manual solid variant available through class composition.

Acceptance:

- `pnpm exec tsc --noEmit`
- Existing app loads.
- No visual change outside token consumers.

### Phase 2: Toolbar And AI HUD

Actions:

1. Migrate toolbar surfaces to new tokens.
2. Reduce blur and shadow in toolbar.
3. Normalize icon button shape and focus states.
4. Refine AI startup state in toolbar and floating panel.

Acceptance:

- AI start does not look frozen during initialization.
- Count text stays stable.
- Progress width does not jump between phases.

### Phase 3: Viewer Controls And RAW Monitor Notices

Actions:

1. Migrate bottom controls and RAW monitor popover to new tokens.
2. Keep photo canvas free of decorative material.
3. Add clear visual language for RAW monitor source:
   - RAW processed
   - embedded fallback
   - cache missing
   - generation running
   - failure cooled down
4. Verify bright photo and dark photo contrast.

Acceptance:

- Viewer controls readable over high-key and low-key photos.
- JPG fallback visible when RAW monitor cache is unavailable.
- No full-screen blur over photo.

### Phase 4: Settings, Export, And Modal Surfaces

Actions:

1. Migrate settings sections to calmer material hierarchy.
2. Keep Pro model diagnostics compact.
3. Make cache scope labels explicit.
4. Unify export selection rows.
5. Keep buttons one-line and stable.

Acceptance:

- Settings text does not feel like a README wall.
- Flash settings do not mention Pro-only capabilities.
- Pro settings show AI engine and RAW monitor state clearly.

### Phase 5: Optional Liquid Glass React Lab

Actions:

1. Create a separate lab branch or dev-only component.
2. Install `liquid-glass-react` only in the lab branch.
3. Test one tiny surface:
   - floating AI button, or
   - RAW monitor compact toggle
4. Measure:
   - app startup
   - viewer navigation
   - CPU/GPU usage
   - Tauri WebView compatibility
   - text readability

Decision:

- If it improves tactile feel with no measurable speed/readability cost, consider a tiny optional component.
- Otherwise keep production on native CSS material tokens.

## Visual QA Plan

Use screenshots at:

- 1440 x 900
- 1920 x 1080
- 2560 x 1440
- narrow desktop window, around 1100px wide

States to capture:

1. Empty import state.
2. Normal viewer with JPG.
3. Viewer with RAW monitor disabled.
4. Viewer with RAW monitor checking.
5. Viewer with RAW monitor fallback.
6. AI idle.
7. AI engine initializing.
8. AI running.
9. AI paused.
10. Settings Flash.
11. Settings Pro.
12. Export dialog.

Manual checks:

- Text does not overlap.
- Buttons do not resize on state changes.
- Image remains visually dominant.
- Glass does not hide photo details.
- Keyboard focus is visible.
- Reduced motion disables sheens.

## Performance QA Plan

Run after each UI implementation phase:

```powershell
pnpm exec tsc --noEmit
pnpm run test -- --run src/components/AiFloatingPanel.test.ts src/utils/concurrency.test.ts
pnpm run build:release:flash
pnpm run build:release:pro
```

For culling speed:

```powershell
pnpm run dev
```

Then test a known folder with 400 to 600 photos and compare:

- AI start to first result
- total analysis time
- viewer navigation latency while AI is running
- memory use after 5 minutes of navigation

Performance budget:

- UI refactor should not increase culling time by more than 5 percent.
- Viewer navigation should not feel worse than current build.
- No glass effect may be added to long scrolling lists unless measured safe.

## Rollback Strategy

### Before Implementation

- Keep this branch separate from release packaging.
- Save:
  - `git status --short`
  - `git diff --stat`
  - screenshots before visual changes

### During Implementation

- One phase, one small commit or patch.
- Avoid mixing UI polish with RAW engine, AI ranker, or release README changes.
- If a phase fails, revert only that phase.

### After Implementation

Rollback options:

1. Token rollback: restore `src/components/ui/chrome.ts` and `src/index.css`.
2. Surface rollback: restore only the touched component, such as `Toolbar.tsx`.
3. Full UI rollback: revert commits from the UI branch.
4. Keep `DESIGN.md` if the rules remain useful, even if code changes are reverted.

## Git Hygiene

Current worktree is already dirty from prior Pro, Flash, RAW, AI, README, and packaging work. Do not run destructive reset commands.

Recommended sequence before code changes:

```powershell
git status --short
git diff --stat
git diff -- src/components/ui/chrome.ts src/index.css src/components/Toolbar.tsx src/components/Viewer.tsx src/components/AiFloatingPanel.tsx src/components/SettingsPanel.tsx
```

If committing:

1. Stage only UI plan and UI implementation files.
2. Do not stage model outputs, release artifacts, RAW cache, or training logs.
3. Keep `.agents/skills/awesome-design-md` either untracked as a local tool or commit it only if you want the repo to carry that skill for future agents.

## Production Recommendation

Use a native CSS/Tailwind Liquid Glass approximation for FrameCull production. Do not add `liquid-glass-react` to Flash or Pro default builds yet.

The best next implementation step is Phase 1: material token layer. It is low risk, improves consistency, and creates a clean rollback point before touching viewer or settings layouts.
