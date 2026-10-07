# native/walk-native/ — 原生遍历源码工程(Rust/napi-rs)

> `native/*.node` 的**源头**:独立 npm 包(name: walk-native),用 napi-rs 重写节点级动态队列并行遍历,
> 供 `src/build-tool/walk/base/walk-utils.ts` 可选加载(TS 实现兜底)。
> 2026-09-30 自仓库根 `walk-native/` 迁入 `native/`(产物与源码工程同域)。

## 关系链

```
native/walk-native/(Rust 源:src/{lib,walker,model,main}.rs + build.rs)
    │  napi build(按平台,输出到 ../../native)
    ▼
native/*.node(3 平台预编译产物,随包分发)
    │  可选加载
    ▼
src/build-tool/walk/base/walk-utils.ts(失败回退纯 TS)
    ▲  一致性/超时/性能验证
scripts/walk-verify/
```

## 构建

`package.json` 内含按平台构建脚本(build:win32-x64 → `napi build … ../../native` 等;另有 zig 全平台脚本)。
`target/`、`node_modules/`、`testdata/` 为本地构建产物/数据,gitignore 不入库。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-30 | 迁入 native/(自仓库根 walk-native/,用户整理裁定):构建脚本输出目标 `../native`→`../../native`,walk-utils 开发候选路径同步;本 README 关系链/构建节同步 |
| 2026-09-29 | 建档(补各文件夹 README 批次):与 native/、walk/base、scripts/walk-verify 的关系链实读归纳 |
