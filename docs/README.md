# docs/ — public documentation source (MkDocs, bilingual)

> Source of the user documentation site, built by the repository-root `mkdocs.yml` (readthedocs theme, `strict: true`).
> **Bilingual by design**: `en/` holds the English pages, `zh-cn/` the Chinese mirrors (same 9 pages each);
> `assets/` is shared by both languages. Any page added or changed must land in **both** folders.

## Layout

```
docs/
├── en/        English pages (index / usage / tutorials / test-explorer / configuration / intellisense / snippets / pixi / troubleshooting)
├── zh-cn/     简体中文镜像(与 en/ 一一对应)
├── assets/    shared screenshots & GIFs (ASCII file names)
└── README.md  this file
```

Page-to-page links are sibling-relative inside each folder; asset references go `../assets/…`.
The nav in `mkdocs.yml` lists both languages as two top-level sections.

> 2026-10-05: the development leftovers (launch-tree docs, debug-support / spec / upstream pipeline screenshots, upstream-branded hero.png) have been **removed** — this directory contains only the live documentation and its referenced screenshots. Keep it that way.
> 2026-10-07: all screenshots replaced with real usage captures (msg/xacro/launch navigation GIFs, smart-build GIF, package-sidebar PNG, test-explorer PNG); upstream screenshots (`MSG_Hover_Doc.png`, `ros_test.png`) deleted.

## Build

```bash
mkdocs serve   # local preview
mkdocs build   # strict build check
```

## Change log

| Time (to the minute) | Note |
|---|---|
| 2026-10-07 | **Bilingual restructure (user decision)**: pages split into `en/` + `zh-cn/` (9 pages each, full Chinese mirrors); mkdocs nav now two top-level language sections, site name → "RDE for ROS 2"; stale content fixed en route (configuration.md dropped the removed debug launch-config block and aligned install-method keys (final, after settings batch A: `installMethod` auto/symlink/copy + `installLayout`), pixi.md `env.env.pixiRoot` typo ×2, tutorials.md dead debug-support links replaced with a learning path) |
| 2026-10-05 | Upstream leftovers removed (three dead launch-tree docs, debug-support/spec screenshots, upstream pipeline screenshots, branded hero.png); index.md rewritten to the extension's real feature set (removed the bogus "debugging support" wording) |
| 2026-10-04 | i18n phase 6: index.md and configuration.md translated to English (setting descriptions aligned with package.nls.json wording) |
| 2026-09-29 | Created (docs-folder README batch): nav 8 pages verified against mkdocs.yml; mixed-in development docs listed as-is (setting key names synced in batch 3, see docs/configuration.md) |
