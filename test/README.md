# ROS 2 Extension Test Files

本目录放扩展的测试与验证脚本。

## 目录结构

- `suite/` —— **单元 / 集成测试**（TypeScript）：集成用例经 `runTest.ts` 起真宿主，其余用 `suite/_vscode-stub.ts` 打桩。
- `run-key-tests.js` —— **无头子集**（不需要 VS Code 宿主）：`node test/run-key-tests.js`。
  ⚠️ 本机（Windows）有 2 个 `Ros2ServiceApi colcon_list` **基线失败**（路径基线差异），与产品代码无关。
- `run-all-tests.js` —— 全量入口；首套件需要宿主 vscode，纯无头环境跑不完（见文件内说明）。
- `runTest.ts` —— `@vscode/test-electron` 启动器（集成测试入口）。
- `vscode-stub.js` / `suite/_vscode-stub.ts` —— vscode API 打桩。
- `run-buildmap-*.js`、`run-install-parity.sh`、`run-quadrant-matrix.sh` —— 构建域 / 安装形态类验证脚本（需真环境）。
- `.env.example` / `.env.test` —— 集成测试所需环境变量样本。

## 常用命令

```bash
npm run test-compile          # tsc → out/（测试先编译到 out/）
node test/run-key-tests.js    # 无头子集
npm test                      # 集成测试（需 .vscode-test 缓存 + ROS/samples）
```

## 已移除：整套调试链路（2026-09-22）

调试链路（launch dumper / 替代运行 runner / 注入桩 / 会话 attach / 运行页 / `ros2` 调试类型 / 测试调试）
已整体删除，随它一起走的还有：18 个调试测试与验证脚本、3 个临时探针、`test/launch/` 全部夹具。

- 决定与理由：`工作交接/已废弃-调试/为什么移除调试-2026-09-22.md`
- 旧文档与旧脚本说明：`工作交接/已废弃-调试/`
- 需要找回代码：从 git 历史取（删除是一次独立提交）。
