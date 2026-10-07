# defaults/ — 三命令出厂 spec(纯函数)

> `share/` 模板机制的出厂默认值:每命令一份「出厂模板 + 动态参数 + 记忆键」,与 package.json
> `default` 预存的整份 spec 由**同步锁用例**锁定不漂移(设置优化批次 2)。全部纯函数、零 vscode。

## 文件

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `colcon-build.ts` | 144 | `COLCON_BUILD_COMMAND_ID`("colcon.build",记忆分槽键)+ 2 条出厂预设(详细输出两半)+ 两轴 `${install_method}/${install_layout}`(经 resolveInstallType)+ `COLCON_BUILD_SPEC` 出厂模板 + 5 动态参数 |
| `ros2-run.ts` | 57 | `ros2 run ${pkg} ${executable} ${0}` 出厂 spec + dynamics + 记忆键 `ros2.run::<pkg>/<exe>`(2026-09-25) |
| `ros2-launch.ts` | 64 | `ros2 launch ${pkg} ${launch_file} ${0}` 出厂 spec + dynamics(pkg/launch_file/launch_path)+ 记忆键 `ros2.launch::<源文件路径>`(2026-09-25) |

## 边界

- 只放默认值,不含任何接线(消费方 = build/share-spec.ts 与 run/share-spec.ts);
- 模板改动必须与 package.json default 同步(同步锁用例会拦)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):三文件职责自 share/README.md 文件表独立成档 |
