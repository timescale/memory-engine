# Handoff: Memory Engine — Redesign (Variation 1 · Console, Light)

## Overview
Memory Engine is an internal tool for browsing, searching, and recalling stored "memories" (notes/records) organized in a project tree. This handoff covers the **modernized redesign** that replaces the dated, utilitarian original UI with a clean, Tiger Data–branded interface. Scope of this package: **Variation 1 ("Console"), light mode only** — a dense, tool-forward three-panel layout.

## About the Design Files
The files in this bundle are **design references created in HTML** — a prototype showing the intended look and behavior, **not production code to copy directly**. The task is to **recreate this design in your target codebase** (e.g. React/Vue/Svelte) using its established components, design tokens, and patterns. If no front-end environment exists yet, choose the most appropriate framework for the project and implement there. Map the literal values below onto your own design-system tokens where equivalents exist.

`MemoryEngineV1.dc.html` is a "Design Component" — it opens directly in a browser. The markup is plain inline-styled HTML; ignore the `<sc-for>` / `<sc-if>` custom tags and the trailing `<script>` (those are the prototype's templating runtime) — the logic you need is just "render the project tree, render the selected memory."

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, and layout are intended to be matched closely. Recreate pixel-for-pixel using your codebase's libraries, substituting your own tokens where they map cleanly (the colors below are straight from the Tiger Data design system).

## Screen: Memory Engine — Console (light)

### Layout
A full-height, full-width flex column:
1. **Top header bar** — 54px tall, horizontal padding 24px, 1px bottom border. Logo + product name (left), space switcher + account (right).
2. **Search/controls bar** — vertical padding 16px, horizontal 24px, 1px bottom border. A flex row, `gap: 12px`: search field (flex-grow), Simple/Advanced segmented toggle, Clear button, refresh icon button.
3. **Body** — a flex row that fills remaining height (`flex: 1; min-height: 0`):
   - **Left sidebar ("explorer")** — fixed `width: 300px`, 1px right border, vertical flex. Header row (label + count pill) then a scrollable tree.
   - **Main content** — flex-grow, scrollable, padding `34px 44px`, inner `max-width: 760px`. Shows the selected memory.

### Components

**Logo mark** — 20×20 SVG, original "memory cell" mark: a rounded square outline (`stroke: currentColor`, 1.6px) containing a 2×2 grid of rounded cells; top-left & bottom-right cells `fill: currentColor`, top-right & bottom-left cells `fill: #F1FF5C`. (No Tiger Data corporate logo — this is a placeholder Memory Engine mark; swap for a real one if/when it exists.)

**Header text** — "Memory Engine" Geist 600 / 15px / letter-spacing -0.01em. "v2.0" badge Geist Mono 11px, opacity .38.

**Header right cluster** — Geist Mono 12px, `gap: 16px`: "space" label (opacity .5); a bordered pill "default ▾" (padding 5×10, 1px border rgba(16,16,19,.16), radius 6); "cevian@gmail.com" and "Sign out" (opacity .5). Replace the account email with the live signed-in user.

**Search field** — height 42px, padding 0 14px, 1px border rgba(16,16,19,.18), radius 8, background rgba(16,16,19,.03). Leading magnifier icon (16px, 1.7 stroke, opacity .5) + placeholder "search memories — hybrid semantic + full-text…" in Geist Mono 13px, opacity .4.

**Simple/Advanced toggle** — segmented control, height 42px, 1px border, radius 8, overflow hidden. Active segment ("Simple"): background `#F1FF5C`, text `#101013`, Geist 600/13px. Inactive ("Advanced"): transparent, opacity .55. Padding 0 16px each.

**Clear button** — height 42px, padding 0 16px, 1px border, radius 8, Geist 500/13px.

**Refresh icon button** — 42×42 square, 1px border, radius 8, centered refresh icon (16px, opacity .7).

**Sidebar header** — between a "explorer" eyebrow (Geist Mono 11px, uppercase, letter-spacing .08em, opacity .5) and a count pill "7,721" (Geist Mono 11px, 600, background `#F1FF5C`, text `#101013`, radius 999, padding 2×8).

**Tree rows** (3 levels + selected state):
- *Root* (e.g. "projects"): Geist 600/13px, caret "▾" (9px, opacity .5), right-aligned count (Geist Mono 11px, opacity .4). Padding 6×10, top margin 6.
- *Child* (e.g. "harness_rag"): Geist 13px, opacity .88, arrow "▸" (8px, opacity .38), indented (`padding-left: 26px`), right-aligned count opacity .33.
- *Memory leaf* (plain): Geist Mono 12px, opacity .6, small 5px square bullet (currentColor, opacity .45), indented `padding-left: 44px`.
- *Memory leaf (selected)*: same indent, Geist Mono 12px/500, background rgba(16,16,19,.08), radius 6, and a **yellow LED dot** leading it — 6px circle `#F1FF5C` with a `0 0 0 3px rgba(241,255,92,.3)` glow ring. **This is the active-row indicator — never a left-border stripe.**

**Main content — selected memory:**
- Breadcrumb "projects / harness_rag" — Geist Mono 12px, opacity .5, margin-bottom 14.
- Title "Hybrid retrieval ranking weights" — Geist 700 / 31px / line-height 1.12 / letter-spacing -0.025em.
- Meta row — Geist Mono 12px, opacity .62, `gap: 13px`: "created Jun 18, 2026" · "1,284 tokens" · "relevance" + a yellow chip "0.94" (background `#F1FF5C`, text `#101013`, radius 4, padding 2×8, 600). Dots "·" at opacity .4.
- Body paragraphs — Geist 15px / line-height 1.7 / opacity .86. Inline `code` (`ts_rank_cd`) in Geist Mono 13px, background rgba(16,16,19,.07), radius 4.
- **SQL code card** — radius 8, 1px border. Header strip: background `#0A0A0C`, 1px bottom border `#27272A`, "sql" eyebrow (Geist Mono 11px, `#A1A1AA`, uppercase) + filename "rank.sql" (`#71717A`). Body `<pre>`: background `#0A0A0C`, text `#D4D4D8`, Geist Mono 13px / line-height 1.7. Syntax highlight: SQL keywords `#F1FF5C`, the `<=>` operator `#FF9B8E`.
- **Tag pills** — flex row `gap: 8px`: each is Geist Mono 12px, 1px border rgba(16,16,19,.16), radius 999, padding 4×11, opacity .82, with a leading 5px blue dot (`#4B7BFF`). Tags: retrieval, ranking, pgvector, sql.

### Interactions & Behavior
The prototype is a static visual mock; intended behavior for the real build:
- **Tree:** root/child rows expand/collapse on click (caret rotates ▸→▾). Clicking a memory leaf selects it and loads it into the main panel.
- **Selected row:** shows the yellow LED dot + subtle gray fill (rgba(16,16,19,.08)).
- **Hover (rows/cards):** per design system — border switches from gray to near-black `#101013`; no shadow, no scale. Sharp/mechanical, ~150–200ms.
- **Hover (primary/yellow):** darken `#F1FF5C` → `#D9E553`.
- **Hover (text links like "Sign out"):** 1px underline appears.
- **Simple/Advanced toggle:** switches search mode (Advanced reveals structured query fields — out of scope here).
- **Search:** hybrid semantic + full-text query over memories.
- **Transitions:** `cubic-bezier(0.22, 1, 0.36, 1)`, 150–200ms. No bounces/overshoots.

### State
- `selectedMemoryId` — currently open memory.
- `expandedNodes` — set of expanded tree node ids.
- `searchQuery`, `searchMode` ('simple' | 'advanced').
- `activeSpace` — selected space ("default").
- Memory tree data + selected memory content fetched from the backend.

## Design Tokens (Tiger Data design system)
**Colors**
- Solar Flare (web accent yellow): `#F1FF5C` — also darker hover `#D9E553`, chip-on-light `#C1CC4A`
- Ink / near-black: `#101013` · code-card black `#0A0A0C` · dark border `#27272A`
- Blue (Eye-of-the-Tiger): `#4B7BFF` (tag dots) · `#3C62CC`
- Red (Tiger Blood) light: `#FF9B8E` (code operator)
- Grays: white `#FFFFFF` · `#A1A1AA` · `#71717A` · `#D4D4D8`
- Surface tints used: `rgba(16,16,19,.03)` field fill, `.07` inline code, `.08` selected row, `.10/.12/.14/.16/.18` borders. (These are opacity-based so they hold up on any near-white surface — in your code, prefer the design-system gray tokens `--gray-300/400` for borders if available.)

**Typography**
- Display/body: **Geist** (300–800). Headings 700.
- Mono: **Geist Mono** (eyebrows, code, counts, meta).
- Pixel/stat: **Geist Pixel Square** — not used in V1; substitute is VT323 (loaded but unused here).
- Key sizes: title 31, body 15, code 13, meta/labels 11–13, eyebrow 11 uppercase.

**Spacing** — 4/8/12/16/20/24/28/32/40/44 px. Header 54px, search controls 42px, sidebar 300px.

**Radius** — fields/buttons/cards 6–8; pills/dots 999; chips 4.

**Shadow** — essentially none; the system is outlined/bordered, not elevated. Only the selected-row LED dot uses a soft ring glow.

## Assets
- **Logo:** inline SVG only (the memory-cell mark) — no external file. Replace with a real Memory Engine logo when available.
- **Icons:** search/refresh/caret/arrow are simple inline SVGs (1.7px stroke). In production use **Phosphor Icons** (the design system's product-chrome icon set) at equivalent sizes.
- **Fonts:** Geist + Geist Mono via Google Fonts (`https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap`).

## Files
- `MemoryEngineV1.dc.html` — the V1 light-mode prototype (open in a browser to view). Reference for exact markup, inline styles, and the SQL code card / tree structure.
- `support.js` — runtime for the prototype so the HTML opens standalone. **Not part of the design** — do not port it.
- `README.md` — this spec (self-sufficient; implement from this alone).
