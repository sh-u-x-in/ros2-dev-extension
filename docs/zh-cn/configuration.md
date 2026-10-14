# 配置

### 工作区与全局设置

扩展注册的全部设置都挂在 `ROS2` 分区下:7 个功能组共 22 个键(设置界面显示为「ROS 2: <分组>」)。权威来源 = package.json 的 `contributes.configuration`;本表为速查参考。

**环境**

| 设置 | 说明 |
|---|---|
| ROS2.env.distro | 要加载的 ROS 发行版(如 humble);留空 = 环境默认 |
| ROS2.env.setupScript | ROS 环境设置脚本路径;留空时由 env.pixiRoot 推导;支持 `${workspaceFolder}` |
| ROS2.env.pixiRoot | Pixi 环境根目录;Windows 上留空回退 `c:\pixi_ws` |
| ROS2.env.systemWatchFiles | 环境采集依赖的 shell 配置文件(Windows 上不监听) |

**构建**

| 设置 | 说明 |
|---|---|
| ROS2.build.installMethod | 安装形态,三值:auto(平台默认:Windows 拷贝 / 其余符号)/ symlink / copy(显式取值优先于平台默认) |
| ROS2.build.installLayout | 安装布局:auto(平台默认:Windows 合并 / 其余分包)/ merged(--merge-install)/ isolated(colcon 默认) |
| ROS2.build.shareSpec | 构建命令模板机制(template + custom + argv_list) |
| ROS2.build.preflightWarnings | 构建前警告模式:on / off / ignore-silent-noop |
| ROS2.build.allowEmptyWorkspace | 无包工作区是否允许空构建 |

**运行与启动**

| 设置 | 说明 |
|---|---|
| ROS2.run.shareSpec | ros2 run 命令模板机制(出厂 = `ros2 run ${pkg} ${executable} ${0}`) |
| ROS2.run.staleWarning | Ctrl+F10 运行/启动时,安装产物比源文件旧则给出非阻塞警告气泡(带「不再显示」按钮) |
| ROS2.launch.shareSpec | ros2 launch 命令模板机制(出厂 = `ros2 launch ${pkg} ${launch_file} ${0}`) |

**消息接口**

| 设置 | 说明 |
|---|---|
| ROS2.msg.systemRefreshMinutes | rosmsg 系统消息索引刷新间隔(分钟) |
| ROS2.msg.workspaceRescanMs | rosmsg 工作区索引强制重扫周期(毫秒;0 = 禁用) |
| ROS2.msg.formatGradientStep | rosmsg 格式化列对齐的梯度分档步长(字符) |
| ROS2.msg.formatLineThreshold | @optional 注解单/双行切换阈值(字符) |

**包发现与搜索**

| 设置 | 说明 |
|---|---|
| ROS2.search.excludeFolders | 扫描时额外排除的目录(11 个内置产物/依赖名始终排除且不可解除) |
| ROS2.search.followSymlinks | 目录搜索是否跟随符号链接(默认关) |
| ROS2.search.walkTimeouts | 按搜索类型的超时/深度覆盖 |
| ROS2.packages.refreshMs | 包列表后台强制重扫周期(毫秒;0 = 禁用;改后自动生效) |
| ROS2.packages.userIndex | 依赖多选列表的用户补充索引:键 = 包名,值 = "[py\|]<描述>"(可选 "py" 前缀强制显示 [纯 Python 包] 标注;描述在包名命中候选时替换该行;未命中不显示) |

**智能感知**

| 设置 | 说明 |
|---|---|
| ROS2.ide.intellisenseEngine | include 条目自动维护引擎:auto / cpptools / clangd / both / none |
| ROS2.ide.entryOverrides.clangd | .clangd 生成条目替换表:键 = 精确 Add token(剥 "- " 前缀),值 = 替换串逐字用,空串 = 删除;链式解析单次同步一步到位,成环剔除该条目 |
| ROS2.ide.entryOverrides.cpptools | c_cpp_properties.json 生成条目替换表:键 = 精确条目串(含 ${workspaceFolder} / 尾部 "**"),值 = 替换串逐字用,空串 = 删除;链式语义同上 |
| ROS2.ide.entryOverrides.python | 双 extraPaths 生成目录替换表:键 = 精确目录串,值 = 替换串逐字用,空串 = 删除;链式语义同上 |
| ROS2.ide.clangdTidy | 接管 .clangd 排序(默认关):每轮同步把托管条目重排为规范组序并重钉本地化分组注释;自加行原序移到 Add 块尾。效果单向 |

**界面**

| 设置 | 说明 |
|---|---|
| ROS2.ui.autoShowOutput | 出现警告或错误时自动打开 ROS 2 输出通道 |
| ROS2.ui.showWelcomeOnStartup | 安装或更新扩展后显示欢迎页 |
| ROS2.ui.showLeftovers | 在包内容视图中显示残留条目:install/ 里仍存在、但最近一次构建已不再声明的文件(改名/删除前的旧可执行、setup.py 里被注释的入口)。默认隐藏——用视图标题栏的眼睛按钮切换 |

`settings.json` 示例:

```json
{
    "ROS2.env.distro": "humble",
    "ROS2.env.setupScript": "/opt/ros/humble/install/setup.bash",
    "ROS2.build.installMethod": "auto"
}
```
