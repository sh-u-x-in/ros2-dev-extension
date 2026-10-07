# native/ — 原生加速模块产物

> napi-rs 预编译二进制(目录遍历加速),由 `src/build-tool/walk/base/walk-utils.ts` **可选加载**,
> 加载失败自动回退纯 TS 实现(功能无损)。源码工程在本目录 `walk-native/` 子目录(2026-09-30 自仓库根迁入)。

## 清单

| 文件 | 说明 |
|:--|:--|
| `walk-native.win32-x64-msvc.node` | Windows x64(MSVC) |
| `walk-native.linux-x64-gnu.node` | Linux x64(glibc) |
| `walk-native.linux-arm64-gnu.node` | Linux arm64(glibc) |
| `index.js` / `index.d.ts` | napi 自动生成的按平台加载器与类型 |

## 注意

- 二进制体积极小且多平台产物需随包分发 → **入库不忽略**(.gitignore 有注记);
- 仅上述 3 平台有产物;darwin/arm64 等需用 `walk-native/` 子目录内的 zig 全平台构建脚本自建;
- 加载点:`walk-utils.ts`(第 33-80 行);验证:`scripts/walk-verify/`。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):二进制清单/加载方/回退行为/构建来源实读归纳 |
