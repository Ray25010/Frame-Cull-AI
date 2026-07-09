# FrameCull AI Design System

## Design Read

FrameCull AI is a desktop photo-culling workstation for photographers. The visual direction is restrained Apple-inspired liquid glass, but the operating principle is closer to Linear and Raycast: quiet chrome, precise density, and clear state. The photo remains the content layer; glass belongs only to controls, panels, and transient overlays.

This is a web approximation of Apple Liquid Glass. Do not present it as an official Apple platform material.

## Design Goals

1. Keep the image dominant. Nothing decorative should sit on top of the photograph unless it helps review, navigation, AI evidence, or RAW monitor state.
2. Make fast culling feel stable. Buttons, counters, ratings, filter states, AI running states, RAW monitor states, and export scope must not jump or resize during work.
3. Use glass as a material hierarchy, not a theme. Toolbar, floating AI panel, viewer controls, inspector, dialogs, and popovers may use glass. Photo canvas, thumbnails, and content previews should stay clean.
4. Preserve Pro and Flash clarity. Flash should feel light and fast. Pro can show more engine status, RAW monitor controls, and model diagnostics, but the layout language stays the same.
5. Keep trust around files. Destructive, metadata-writing, cache-clearing, and export actions need explicit labels, stable affordances, and no playful ambiguity.

## Reference Blend

- Apple material guidance: glass should distinguish interactive chrome from content, not become the content layer.
- Linear reference: near-black surface ladder, hairline borders, restrained accent, no decorative color.
- Raycast reference: compact command-style desktop utility, dark surface ladder, small radii, fast state feedback.
- Awesome Design MD reference: use DESIGN.md as durable agent-readable design context, but do not copy a foreign brand system wholesale.

## Color System

### Dark Theme

- `canvas`: `#121214`, app background behind work surfaces.
- `canvas-raised`: `#17191d`, toolbar and side panel base.
- `surface-1`: `rgb(255 255 255 / 0.035)`, quiet grouped surface.
- `surface-2`: `rgb(255 255 255 / 0.055)`, hover or selected container.
- `hairline`: `rgb(255 255 255 / 0.06)`, default border.
- `hairline-strong`: `rgb(255 255 255 / 0.12)`, focus or selected border.
- `ink`: `#f4f4f5`, primary text.
- `ink-muted`: `#a1a1aa`, secondary text.
- `ink-subtle`: `#71717a`, tertiary text.
- `accent`: `#22d3ee`, AI and active chrome accent.
- `success`: `#34d399`, clear or completed state.
- `warning`: `#fbbf24`, review state.
- `danger`: `#fb7185`, destructive or hard issue state.

### Light Theme

- `canvas`: `#f4f6f8`, app background.
- `canvas-raised`: `rgb(226 232 240 / 0.92)`, toolbar and side panel base.
- `surface-1`: `rgb(255 255 255 / 0.62)`, grouped surface.
- `surface-2`: `rgb(255 255 255 / 0.82)`, hover or selected container.
- `hairline`: `rgb(100 116 139 / 0.24)`, default border.
- `hairline-strong`: `rgb(14 165 233 / 0.36)`, focus or selected border.
- `ink`: `#0f172a`, primary text.
- `ink-muted`: `#475569`, secondary text.
- `ink-subtle`: `#64748b`, tertiary text.
- `accent`: `#0891b2`, AI and active chrome accent.
- `success`: `#047857`, clear or completed state.
- `warning`: `#b45309`, review state.
- `danger`: `#be123c`, destructive or hard issue state.

## Material Tokens

Use three material levels only.

### `chromeSolid`

Use for dense sidebars, filmstrip rails, and inspector backgrounds when readability matters more than glass.

- Dark: opaque or near-opaque `#17191d`.
- Light: near-opaque `#e2e8f0`.
- Blur: none.
- Shadow: none or inset 1px highlight only.

### `chromeGlass`

Use for toolbar, viewer bottom controls, AI floating panel, RAW monitor popover, and dialogs.

- Dark background: `rgb(23 25 29 / 0.84)`.
- Light background: `rgb(226 232 240 / 0.82)`.
- Border: one hairline.
- Blur target: 24px to 40px. Avoid 70px+ except tiny transient popovers.
- Saturation: 130 percent to 150 percent.
- Shadow: soft and shallow, no stacked heavy shadows by default.

### `chromeActive`

Use for selected toggles, current filter, AI running indicator, and active monitor mode.

- Same base as `chromeGlass`.
- Add accent-tinted inset highlight.
- Text must remain high contrast.
- Do not animate color continuously.

## Typography

- Keep the existing system stack: Segoe UI Variable Text, Segoe UI, Noto Sans SC, Noto Sans, Microsoft YaHei UI, sans-serif.
- Do not add a decorative display font to product UI.
- Keep letter spacing at 0 for UI labels and body.
- Product headings use fixed sizes, not viewport-based fluid type.
- Recommended scale:
  - Toolbar label: 12px, 600.
  - Body control label: 13px to 14px, 500 to 600.
  - Panel title: 16px to 19px, 600 to 700.
  - Metric: tabular number, 11px to 13px.
  - Fine print: 10.5px to 12px, only for metadata and diagnostics.

## Shape System

- Icon button: 7px to 8px radius.
- Small segmented control: 8px radius.
- Toolbar groups and compact panels: 10px to 12px radius.
- Dialog and large popover: 12px to 14px radius.
- Pills only for status chips, not general buttons.
- Do not use 24px+ rounded cards for dense work surfaces.

## Motion Policy

- Motion exists for state, not decoration.
- Default transition: 140ms to 180ms ease-out.
- Progress sheens are allowed for AI engine initialization and cache generation, but they must pause with `prefers-reduced-motion: reduce`.
- No page-load choreography.
- No animated background behind the photo.
- No hover motion that shifts layout.

## Component Rules

### Toolbar

- Toolbar is compact chrome, not a hero.
- Keep the center AI progress area stable in width.
- Do not show model branding in the scanned count. Engine status belongs in the AI panel or a short initializing state.
- Use a single accent for active AI controls.

### Viewer

- The viewer is the content layer.
- Photo canvas must not use decorative glass.
- Bottom controls may use `chromeGlass`, but opacity must be high enough to read over bright photos.
- RAW monitor and auto exposure notices should be small, anchored, and dismiss visual noise quickly.
- Never block the JPG fallback when RAW monitor cache is missing or failed.

### Filmstrip

- Prefer solid or lightly translucent rail.
- Current image state must be obvious through border, rail, or small status glyph.
- Avoid heavy blur on long scrolling thumbnail lists for performance.

### Inspector

- Use `chromeSolid` for the main inspector column.
- Use `surface-1` groups instead of nested glass cards.
- AI evidence, hard issues, ratings, and duplicate state must be scan-friendly.

### AI Floating Panel

- Use `chromeGlass` sparingly and keep it small.
- Starting state can say `AI 美学引擎启动中`.
- Running state should show progress, elapsed time, current phase, and pause/resume.
- Avoid wording that makes the app sound like it is changing ratings or deleting files automatically.

### Settings

- Settings can use calmer card grouping, but no nested decorative cards.
- Pro-only model and RAW monitor controls must be clearly separated from Flash controls.
- Cache controls need exact scope: AI cache, RAW monitor cache, preview cache, or all cache.

### Export

- Export choices should use the same selection UI pattern across rows.
- Rename section title should read as a section, with `命名为` before the text field.
- Metadata text should be concise and not over-explain below headings.

## Accessibility Rules

- Body text contrast target: WCAG AA 4.5:1.
- Large labels and icon buttons must remain readable on both dark and light themes.
- Every icon-only button needs a title or accessible label.
- Every control must have visible focus state.
- Color cannot be the only signal for AI issue, selected, rejected, or RAW fallback state.
- Provide reduced-motion fallback for all animated sheens and progress indicators.
- Treat reduced transparency as a product requirement even if browser support is uneven: provide solid fallbacks.

## Performance Budget

- Avoid full-screen `backdrop-filter`.
- Avoid blur on scroll-heavy surfaces such as filmstrip thumbnail lists.
- Do not add `liquid-glass-react` to the default path until measured. It can be tested in an isolated lab component or optional dev branch.
- Any glass component over the viewer should be small, fixed-size, and not continuously animated.
- Screenshot and culling performance must be verified after every visual pass.

## Do Not Do

- Do not make FrameCull look like a landing page.
- Do not use purple-blue gradients as brand identity.
- Do not add ornamental motion behind photos.
- Do not place glass cards inside glass cards.
- Do not put decorative text labels over photographs.
- Do not make RAW monitor, AI scoring, or cache state ambiguous.
- Do not change Flash and Pro feature boundaries while doing visual work.

## Rollback Rule

All UI refactors must land in small reversible phases. Before each phase:

1. Save `git status --short` and `git diff --stat` under `output/ui-redesign-preflight`.
2. Keep changes grouped by surface or token layer.
3. Verify typecheck and the relevant UI smoke path.
4. If a visual pass hurts culling speed, contrast, or keyboard flow, revert that phase only.
