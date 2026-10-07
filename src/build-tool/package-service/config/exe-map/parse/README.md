# parse/ — 构建配置解析器(断电留档)

> exe-map 的解析子层;随 exe-map 断电(2026-09-04)**不参与编译**(tsconfig exclude),代码留档仅供历史参考。
> 上级见 `../README.md`(断电横幅与文件表)。

## 文件

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `cmake-parser.ts` | 501 | CMakeLists 聚焦提取:命令扫描器 + 变量表 + dynamic 标记 |
| `setup-parser.ts` | 1394 | setup.py v5:静态解析 + 安全展开动态 + 指纹 |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):两文件职责自 exe-map/README 文件表独立成档;断电状态如实钉明 |
