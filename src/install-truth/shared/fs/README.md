# fs/ — 注入式文件系统原语

> 第 0 层的基础设施:可注入 fs 抽象(单测任意平台复现 + 域包含性守卫夹具)。
> 上级见 `../README.md`;域级设计见 `../../README.md`。

## 文件(1 TS,434 行)

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `primitives.ts` | 434 | `FsLike`(stat/lstat/readlink/readdir/readText)+ `nodeFsLike`(真实 fs)+ `MemoryFs`(addLink/chmod/逐段软链解析/显式时间戳,单测夹具)+ `walkFiles`/`isDir`/`isFile` + **`guardDomain`**(域包含性守卫:只按访问字符串放行 build/install 根内调用;经 `api.ts` 导出,不变式三夹具) |

## 关键约定

- `FsStat` 带 `kind`(file/dir/link,soft link 仅 `lstat` 可见)/ `mode` / `mtimeMs`(新鲜度守卫依据);
- `MemoryFs` 逐段解析软链——否则经目录软链访问的路径在内存 fs 里查不到(保真度问题);
- 依赖方向:不 import 上层(scan/center);lstat/readlink 于 2026-09-21 甲-1 请回(软链就是安装机制本身)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):单文件职责自头注与上级 README 独立成档(文件头过期注释已于批次B 修正) |
