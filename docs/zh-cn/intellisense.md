# 智能感知

ROS 2 机器人开发扩展为 ROS 消息文件(`.msg`、`.srv`、`.action`)提供丰富的智能感知支持,让接口开发更轻松。

## 消息文件智能感知

编辑 ROS 消息文件时,扩展提供多项智能感知能力,帮助你理解消息结构。

### 悬停信息

悬停在消息类型或字段名上,会显示该类型的详细信息,包括其属性。

### 补全与跳转定义

在消息文件中输入时有类型补全(覆盖工作区与系统包),对消息类型按 **F12** / **Ctrl+单击**可直接跳到定义文件——包括下面演示的字段级补全:

![消息类型补全与跳转定义](../assets/msg-intellisense.gif)

#### 悬停消息类型

悬停在消息类型上(如 `geometry_msgs/Point`、`std_msgs/Header`、`builtin_interfaces/Duration`),悬浮框显示:

- **包名**:消息所在的 ROS 包
- **消息类型**:消息名称
- **属性**:格式化的字段清单,包括:
  - 字段类型与名称
  - 数组标记(定长 `[N]` 或变长 `[]`)
  - 默认值与常量
  - 消息定义中的行内注释

**示例**:悬停 `geometry_msgs/Vector3` 显示:
```
geometry_msgs/Vector3

Package: Geometric primitive messages for representing common geometric shapes
Message Type: Vector3

Properties:
float64 x
float64 y
float64 z
```

#### 悬停字段名

悬停在字段名上,同时给出字段与类型的完整信息:

- 字段声明及默认值
- 字段关联的行内注释
- 完整的类型文档(与悬停类型相同)
- 该字段消息类型的全部属性

**示例**:悬停如下行中的 `angular_velocity`:
```
geometry_msgs/Vector3 angular_velocity
```

会显示字段声明,并附 `Vector3` 类型及其属性的完整文档。

#### 内置类型

悬停 ROS 内置类型(如 `int32`、`float64`、`string` 等)时显示:

- 类型名
- 类型描述
- 适用时的取值范围信息
- 字段为数组时的数组信息

**示例**:悬停 `float64` 显示:
```
float64

64-bit floating point number (double precision)
```

### 工作区包与系统包

智能感知对两类包同样生效:

- **工作区包**:当前工作区内定义的消息
- **系统安装包**:已安装 ROS 包中的消息(如 `geometry_msgs`、`sensor_msgs`、`builtin_interfaces`)

扩展按以下顺序查找消息定义:
1. 工作区文件夹
2. ROS 包路径(取自 ROS 环境)

无论自定义消息还是 ROS 标准消息,悬停信息一视同仁。

### 跳转定义

对消息类型按 **F12** 或 **Ctrl+单击**(macOS 为 Cmd+单击)跳到其定义文件;工作区包与系统包均支持。

### 支持的文件类型

智能感知可用于:

- **`.msg` 文件**:ROS 消息定义
- **`.srv` 文件**:ROS 服务定义
- **`.action` 文件**:ROS 动作定义

## Xacro / URDF 导航

对 `.xacro` 与 `.urdf` 文件,扩展构建 include 图并提供精确导航:**Ctrl+单击** `<xacro:include filename>` 打开被包含文件;对宏调用、`${}` 属性/参数引用、link/joint 名称按 **F12** 跳到定义(考虑宏形参遮蔽),并配套悬浮文档与 D1–D14 诊断:

![xacro include 与变量跳转](../assets/xacro-navigation.gif)

## Launch 文件导航

在 launch 文件(`.launch.py` / `.launch.xml` / `.launch.yaml`)中,**Ctrl+单击** include 目标可打开被引用的启动文件;对 `pkg=` / `executable=` 值单击可跳到包目录或可执行文件源码(无法解析的目标会明确标注,而不是跳到错误位置):

![launch 文件可执行与 include 跳转](../assets/launch-navigation.gif)

## C++ 与 Python 智能感知

对使用 ROS 的 C++ 与 Python 代码,在命令面板执行 **ROS2: 重新生成智能感知配置(补写)**。扩展同时维护两侧引擎:

- **cpptools**:自动同步 `.vscode/c_cpp_properties.json` 的 include 路径(ROS 安装路径 + 工作区各包);
- **clangd**:自动同步 `.clangd`(工作区 `-I` 条目 + 各前缀 `-isystem` 条目),并把每个包的 `compile_commands.json` 合并进 `build/compile_commands.json`;
- 引擎可经 `ROS2.ide.intellisenseEngine` 选择(`auto` / `cpptools` / `clangd` / `both` / `none`);包或 ROS 环境变化时路径自动再生。

## 提示

- **保持 ROS 环境已加载**:确保 ROS 环境正确 source,扩展才能找到所有包定义
- **装完新包后重载窗口**:新装 ROS 包后可能需要重载 VS Code 窗口以纳入新定义
- **开发时多用悬停**:悬停信息可以快速核对消息结构,不用切文件
- **与跳转定义配合**:悬停预览,F12 深入完整定义
