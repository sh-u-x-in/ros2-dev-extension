# create 子域 · member_of_group 与包选择的关系研讨（限定 humble 原始清单）

> 状态：**研讨（2026-09-01）**
> 目的：模拟「依赖多选勾选哪些包 → 生成包是否自动注入 `<member_of_group>rosidl_interface_packages</member_of_group>`」
> 范围：**仅**用户提供的 humble 桌面完整版 `ros2 pkg list` 清单内的包
> 核心规则：同时勾选**接口生成器 + 接口运行支撑**（"标配对"）→ 自动注入 member_of_group。
>   理由：**不包含可能会有事**（用户后续补 msg/srv/action 时组缺失 → 生成跳过/工具扫描不到）；
>   **包含不会多**（无 IDL 文件时组注册是惰性元数据，不触发任何生成）。
> 约定：时间精确到分钟（YYYY-MM-DD HH:mm），见文末修改记录。

---

## 1. member_of_group 职责（先钉死，避免概念漂移）

- **不是依赖标签**：它和 build/exec/export/buildtool 正交——声明的是"本包属于哪个**生成器组**"；
- 清单里唯一在用的组：`rosidl_interface_packages`；
- 作用：① 触发 rosidl 代码生成（有 IDL 文件时）；② 注册进接口索引（`ros2 interface list/show` 可查）；
- **使用方不需要**：勾选 std_msgs 只是"用消息"，不触发本规则；
- **惰性成立**：仅有组声明、无 `.msg/.srv/.action` 文件、CMakeLists 未调 `rosidl_generate_interfaces` → colcon 视为空组成员，零副作用（`std_msgs` 等接口包加它是因为真在定义接口）。

---

## 2. 触发逻辑：接口意图的"标配对"

接口包（定义方）的 package.xml 铁三角（以清单内 std_msgs 为范本）：

```xml
<buildtool_depend>rosidl_default_generators</buildtool_depend>   <!-- 生成器(buildtool) -->
<exec_depend>rosidl_default_runtime</exec_depend>               <!-- 运行支撑(exec) -->
<member_of_group>rosidl_interface_packages</member_of_group>    <!-- 组声明(本规则产物) -->
```

**判定**：勾选结果同时含"生成器侧 ≥1"且"运行支撑侧 ≥1" → 接口意图成立 → 自动注入 member_of_group。

### 清单内的"生成器侧"包（buildtool，勾选信号 A）
`rosidl_default_generators`、`rosidl_generator_c`、`rosidl_generator_cpp`、`rosidl_generator_py`、`rosidl_generator_rs`、`rosidl_typesupport_fastrtps_c`、`rosidl_typesupport_fastrtps_cpp`、`rosidl_cmake`、`rosidl_adapter`、`rosidl_parser`、`rosidl_cli`

### 清单内的"运行支撑侧"包（exec，勾选信号 B）
`rosidl_default_runtime`、`rosidl_runtime_c`、`rosidl_runtime_cpp`、`rosidl_runtime_py`、`rosidl_typesupport_c`、`rosidl_typesupport_cpp`、`rosidl_typesupport_interface`、`rosidl_typesupport_introspection_c`、`rosidl_typesupport_introspection_cpp`

---

## 3. 决策矩阵（限定清单内包）

| # | 勾选组合（举例） | 注入 member_of_group？ | 理由 |
|---|---|---|---|
| 1 | **`rosidl_default_generators` + `rosidl_default_runtime`**（标配对） | ✅ **是** | 接口意图最明确；不含有事、含无多 |
| 2 | `rosidl_generator_cpp` + `rosidl_default_runtime` | ✅ 是 | 等价标配对（生成器侧任选 + 运行支撑任选） |
| 3 | `rosidl_default_generators` + `rosidl_runtime_cpp` | ✅ 是 | 同上（运行支撑侧任选） |
| 4 | 仅 `rosidl_default_generators`（无运行支撑） | ❌ 否 | 只声明构建工具 ≠ 定义接口；缺运行支撑接口包不完整，不应给组声明 |
| 5 | 仅 `rosidl_default_runtime`（无生成器） | ❌ 否 | 运行支撑 ≠ 定义接口 |
| 6 | 仅勾消息包 `std_msgs`/`geometry_msgs`/`nav_msgs`… | ❌ 否 | **使用消息 ≠ 定义消息**；使用方只需 depend |
| 7 | 勾 `builtin_interfaces`/`action_msgs`（接口依赖） | ❌ 否 | 它们是"接口包的依赖"，不是接口意图信号；除非同时有标配对 |
| 8 | 勾普通库 `rclcpp`/`tf2_ros`/`pluginlib`… | ❌ 否 | 与接口无关 |
| 9 | 标配对 + 任意 `*_msgs`/`*_interfaces` 依赖 | ✅ 是 | 标配对已成立，加消息依赖只是正常 depend |

**边界确认**：
- #4/#5 的"半对"不触发——生成器对与运行支撑对**必须成对**，因为接口包的铁三角是三件套（buildtool+exec+group），缺一即意图不完整；
- #6 是最容易误触发的场景：用户勾 std_msgs 只是想用消息，**绝不能**因此注入组声明（那会把"使用方"错标成"定义方"）。

---

## 4. 与 create 流程的衔接（注入点与副作用）

1. **注入位置**：package.xml 的 `<export>` 前追加 `<member_of_group>rosidl_interface_packages</member_of_group>`（与 `<buildtool_depend>`/`<exec_depend>` 同级，紧邻依赖段）；
2. **CMakeLists 不动**：接口生成段保持注释形态（`rosidl_generate_interfaces` 注释块），等用户真正加 .msg 文件时再激活——注入组声明不影响它；
3. **注入后无文件**：`ros2 interface list` 会列出该包（空接口包），无任何构建副作用；
4. **用户后续加 msg/srv/action**：补 CMakeLists 激活生成段即可，组声明已就位，代码生成直接生效——这正是"不含有事、含无多"的落地形态。

---

## 5. 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-01 22:40 | 建档:member_of_group 与包选择关系研讨(限定 humble 清单)——钉死职责(组声明≠依赖标签)、定义"标配对"(生成器侧+运行支撑侧各≥1)触发规则、9 行决策矩阵(含最容易误触发的"使用消息≠定义消息"边界)、注入点与零副作用论证 |
| 2026-09-02 00:03 | **实施落地**:dep-catalog.ts 新增 INTERFACE_GENERATOR_SIDE(11)/INTERFACE_RUNTIME_SIDE(9)/hasInterfaceIntent(标配对判定);create-cpp-package 与 create-python-package 的 package.xml 在标配对成立时自动注入 <member_of_group>rosidl_interface_packages</member_of_group>(无 IDL 文件惰性无害);新增 6 个测试(判定 + 两生成器注入/半对/只勾消息包) |
