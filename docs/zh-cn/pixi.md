# Pixi 与 ROS 2

[Pixi(prefix.dev 出品)](https://pixi.sh/latest/)是新一代包管理器,支持 ROS 2 开发环境,提供跨平台管理 ROS 2 工作区、依赖与工具的方式。

Open Robotics 已将 Pixi 列为 Windows 开发的标准方案。

## RoboStack 与 Open Robotics

Open Robotics 与 RoboStack 合作提供基于 Pixi 的 ROS 2 开发环境,可与本扩展无缝配合,跨平台提供一致的开发体验。

- **Open Robotics 官方发行版**:经 Open Robotics 构建系统提供核心 ROS 组件,**生产环境推荐**;
- **RoboStack 社区发行版**:社区维护,包含官方发行版没有的额外包,**开发与测试推荐**。

## Pixi + ROS 2 + 本扩展 入门

1. **安装 Pixi**:按 [Pixi 官网](https://pixi.sh/latest/)指引安装;
2. **安装 Visual Studio**:Windows 上构建 ROS 2 包需要([下载](https://visualstudio.com/));
3. **安装 Visual Studio Code**([下载](https://code.visualstudio.com/));
4. **按用途安装 ROS 2**:
   - 开发测试:按 [RoboStack 官网](https://robostack.github.io/)指引;
   - 生产环境:按 [ros.org](https://docs.ros.org/en/kilted/Installation/Windows-Install-Binary.html) 指引;
5. **安装本扩展**:从 [VS Code 扩展市场](https://marketplace.visualstudio.com/)或 [Open-Vsx.org](https://open-vsx.org/) 安装;
6. **在扩展中配置 Pixi**:
   - 打开工作区设置;
   - 设置 `ROS2.env.pixiRoot` 指定 Pixi 环境根目录:Windows 留空回退 `c:\pixi_ws`;mac/Linux 无默认推导(使用 Pixi 必须显式配置);
   - 扩展会按平台与 Pixi 配置自动探测并使用正确的 setup 脚本;
7. **打开 ROS 2 工作区**:打开包含 ROS 2 工作区的文件夹,扩展自动探测环境并完成配置。

## Pixi 环境探测

扩展通过以下方式自动探测 Pixi 环境:
- 检查工作区中的 `pixi.toml` 或 `pixi.lock`;
- 在配置的 `env.pixiRoot` 下查找 Pixi 环境目录;
- 探测当前 shell 会话中已激活的 Pixi 环境。

启用 Pixi 后扩展会:
- 从 Pixi 环境 source 对应的 ROS 2 setup 脚本;
- 将 Python 环境配置为使用 Pixi 管理的包;
- 为 ROS 2 包搭建基于 Pixi 的构建环境。

## 平台行为

- **Windows**:使用 Pixi ROS 2 环境的 `local_setup.bat`
- **Linux**:使用 `local_setup.bash`
- **macOS**:使用 `local_setup.bash`

## 故障排查

- 确认 Pixi 安装正确、终端里 `pixi` 命令可用;
- 查看 [VS Code 输出面板](troubleshooting.md)中与本扩展相关的报错;
- 使用 RoboStack 时,先确认 ROS 2 包在扩展之外安装、环境本身可用;
- 确认 `ROS2.env.pixiRoot` 指向正确的 Pixi 安装目录;
- Pixi 本身的问题参考 [Pixi 文档](https://pixi.sh/latest/docs/)或 [Pixi Discord](https://discord.gg/kKV8ZxyzY4) 社区。
