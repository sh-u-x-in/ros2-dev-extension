# media/ — 打包媒体资源

> 随 vsix 公开发布的资源(图标 + walkthrough 文档),由 package.json 贡献点引用。

## 清单

| 文件 | 消费方 |
|:--|:--|
| `icon.png`(320×320) | 扩展图标(package.json `icon`) |
| `ros2-packages.svg` | 活动栏容器/视图图标(`viewsContainers`/`views`;R 字母 monogram,纯 path 描边零字体依赖,24×24 随主题) |
| `walkthroughs/getting-started.md` | walkthrough `ros2.gettingStarted` 步骤 1 |
| `walkthroughs/commands-and-features.md` | walkthrough `ros2.gettingStarted` 步骤 2 |

## 注意

- 修改 walkthrough md 需同步核对 package.json `walkthroughs` 贡献点;
- 图标铁律(2026-09-28):图标必须镂空描边 + 随主题变色(见 consumers/monitor/webview/icons.ts 同规)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-04 18:39 | R 字母放大 10%(用户裁定「再大一点点」):几何坐标按中心 (12,12) 均匀 1.1×(字高 16→17.6/24,顶/底/左右余量各 ~2.1),笔画 2.25 不变;浏览器截图对比 现行/+10%/+20% 三档后取 +10% |
| 2026-10-04 14:44 | 图标立方体→R 字母 monogram(用户三候选 V1/V2/V3 预览裁定取 V2):纯 path 描边(圆弧碗+斜腿,笔画 2.25@24)零字体依赖,stroke=currentColor 随主题;淘汰用户的 R2 重叠草案(颜色蒸发/发丝笔/text 字体依赖,浏览器截图实证) |
| 2026-09-29 | 建档(补各文件夹 README 批次):四文件消费方按 package.json 贡献点核对 |
