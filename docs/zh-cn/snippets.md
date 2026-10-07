# 代码片段

本扩展内置全套代码片段,加速 Python、C++ 与 launch 文件开发。

## 用法

1. 在编辑器中输入片段前缀
2. 按 `Tab` 或 `Enter` 展开
3. 用 `Tab` 在占位符间跳转
4. 填入所需值

## Python(rclpy)片段

### 节点开发

| 前缀 | 说明 |
|--------|-------------|
| `ros2node` | 完整 ROS 2 Python 节点类模板(含 main 函数) |
| `ros2pub` | 创建发布者 |
| `ros2pubtimer` | 创建带定时回调的发布者 |
| `ros2sub` | 创建带回调的订阅者 |
| `ros2timer` | 创建带回调的定时器 |

### 服务

| 前缀 | 说明 |
|--------|-------------|
| `ros2srv` | 创建服务端 |
| `ros2client` | 创建客户端 |
| `ros2call` | 发起异步服务调用 |

### 动作

| 前缀 | 说明 |
|--------|-------------|
| `ros2actionserver` | 创建动作服务器 |
| `ros2actionclient` | 创建动作客户端 |

### 参数

| 前缀 | 说明 |
|--------|-------------|
| `ros2param` | 声明参数 |
| `ros2getparam` | 获取参数值 |
| `ros2declgetparam` | 声明并获取参数 |

### 日志

| 前缀 | 说明 |
|--------|-------------|
| `ros2debug` | 输出 debug 日志 |
| `ros2info` | 输出 info 日志 |
| `ros2warn` | 输出 warning 日志 |
| `ros2error` | 输出 error 日志 |
| `ros2fatal` | 输出 fatal 日志 |

### 服务质量(QoS)

| 前缀 | 说明 |
|--------|-------------|
| `ros2qos` | 创建 QoS 配置 |

## C++(rclcpp)片段

### 节点开发

| 前缀 | 说明 |
|--------|-------------|
| `ros2node` | 完整 ROS 2 C++ 节点类模板(含 main 函数) |
| `ros2component` | 组件节点模板(含注册宏) |
| `ros2pub` | 创建发布者 |
| `ros2pubtimer` | 创建带定时回调的发布者 |
| `ros2sub` | 创建订阅者 |
| `ros2sublambda` | 创建 lambda 回调订阅者 |
| `ros2timer` | 创建带回调的定时器 |

### 服务

| 前缀 | 说明 |
|--------|-------------|
| `ros2srv` | 创建服务端 |
| `ros2client` | 创建客户端 |
| `ros2call` | 发起异步服务调用 |

### 动作

| 前缀 | 说明 |
|--------|-------------|
| `ros2actionserver` | 创建动作服务器 |
| `ros2actionclient` | 创建动作客户端 |

### 参数

| 前缀 | 说明 |
|--------|-------------|
| `ros2param` | 声明参数 |
| `ros2getparam` | 获取参数值 |
| `ros2declgetparam` | 声明并获取参数 |

### 日志

| 前缀 | 说明 |
|--------|-------------|
| `ros2debug` | 输出 debug 日志(RCLCPP_DEBUG) |
| `ros2info` | 输出 info 日志(RCLCPP_INFO) |
| `ros2warn` | 输出 warning 日志(RCLCPP_WARN) |
| `ros2error` | 输出 error 日志(RCLCPP_ERROR) |
| `ros2fatal` | 输出 fatal 日志(RCLCPP_FATAL) |

### 组件注册

| 前缀 | 说明 |
|--------|-------------|
| `ros2register` | 用 RCLCPP_COMPONENTS_REGISTER_NODE 注册组件节点 |

### 服务质量(QoS)

| 前缀 | 说明 |
|--------|-------------|
| `ros2qos` | 创建 QoS 配置 |

## Python Launch 文件片段

| 前缀 | 说明 |
|--------|-------------|
| `ros2launch` | 完整 launch 文件模板 |
| `ros2launchnode` | 启动节点(全选项) |
| `ros2node` | 简单启动节点 |
| `ros2launchremap` | 带话题重映射的启动节点 |
| `ros2launchinclude` | 包含另一个 launch 文件 |
| `ros2launcharg` | 声明 launch 参数 |
| `ros2launchgetarg` | 获取 launch 参数值 |
| `ros2launchexec` | 执行进程 |
| `ros2composable` | 创建可组合节点容器 |
| `ros2launchgroup` | 创建带命名空间的组动作 |
| `ros2launchparam` | 设置参数 |
| `ros2lifecycle` | 启动生命周期节点 |

## XML Launch 文件片段

| 前缀 | 说明 |
|--------|-------------|
| `ros2launch` | 完整 XML launch 文件模板 |
| `ros2node` | 简单启动节点 |
| `ros2nodens` | 带命名空间的启动节点 |
| `ros2nodeblock` | 块元素形式启动节点 |
| `ros2arg` | 声明带默认值的 launch 参数 |
| `ros2argnodefault` | 声明无默认值的 launch 参数 |
| `ros2include` | 包含另一个 launch 文件 |
| `ros2includeargs` | 带参数包含 launch 文件 |
| `ros2param` | 设置参数 |
| `ros2paramfile` | 从 YAML 文件加载参数 |
| `ros2remap` | 重映射话题 |
| `ros2group` | 创建组块 |
| `ros2namespace` | 压入 ROS 命名空间 |
| `ros2env` | 在节点内设置环境变量 |
| `ros2setenv` | 全局设置环境变量 |
| `ros2let` | 定义变量 |
| `ros2var` | 取变量值 |
| `ros2getenv` | 获取环境变量 |
| `ros2findpkg` | 查找包 share 目录 |
| `ros2exec` | 执行命令 |

## 示例

### Python 节点示例

输入 `ros2node` 按 Tab 得到:

```python
import rclpy
from rclpy.node import Node


class MyNode(Node):
    def __init__(self):
        super().__init__('my_node')
        

def main(args=None):
    rclpy.init(args=args)
    node = MyNode()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
```

### C++ 节点示例

输入 `ros2node` 按 Tab 得到:

```cpp
#include "rclcpp/rclcpp.hpp"

class MyNode : public rclcpp::Node
{
public:
    MyNode() : Node("my_node")
    {
        
    }

private:
    
};

int main(int argc, char * argv[])
{
    rclcpp::init(argc, argv);
    rclcpp::spin(std::make_shared<MyNode>());
    rclcpp::shutdown();
    return 0;
}
```

### Python Launch 文件示例

输入 `ros2launch` 按 Tab 得到:

```python
from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        
    ])
```

## 提示

- 所有片段用制表位在占位符间跳转
- `Tab` 下一个占位符,`Shift+Tab` 上一个
- 部分片段含选择型占位符——用方向键选选项
- VS Code 与 VSCodium 均可用

## 设计原则

这些片段遵循:

1. **加速开发** —— 减少样板输入
2. **遵循惯例** —— 符合 ROS 2 官方约定
3. **易于发现** —— 统一 `ros2` 前缀,直观可猜
4. **覆盖全面** —— 涵盖常见 ROS 2 模式
5. **手感一致** —— 制表位顺序一致、默认值合理
