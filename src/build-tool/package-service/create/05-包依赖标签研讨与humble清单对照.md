# create 子域 · package.xml 依赖标签研讨 + humble 全量清单对照

> 状态：**研讨结论（2026-09-01，源码验证）**
> 目的：回答「哪些依赖不该 3 个标签全标（depend）」，并为 create 依赖多选的**标签分类（depTagClass）**提供依据
> 依据：REP-149 + ament_cmake/ament_package/catkin_pkg 源码 + 官方包实例（std_msgs / demo_nodes_cpp / ros_base / desktop 的 package.xml）
> 范围：humble 桌面完整版 `ros2 pkg list` 原版输出（用户提供）逐包对照
> 约定：时间精确到分钟（YYYY-MM-DD HH:mm），见文末修改记录。

---

## 1. 权威语义（源码验证，非传说）

### 1.1 标签全景（format 3）

| 标签 | 含义 | 何时用 |
|---|---|---|
| `<depend>` | **= build + build_export + exec 三标签简写**（REP-149；catkin_pkg 解析时展开） | 代码里既编译又运行、通常传导的常规依赖 |
| `<build_depend>` | 仅编译期 | 编译需要的东西 |
| `<build_export_depend>` | 编译期 + **传导给下游** | 你的公共头文件 / `ament_export_dependencies()` 引用了它 |
| `<exec_depend>` | 仅运行期 | 共享库、可执行、Python 模块、launch 脚本 |
| `<buildtool_depend>` | 构建工具/代码生成器 | ament_cmake、rosidl_default_generators |
| `<buildtool_export_depend>` | 构建工具传导下游 | 少见 |
| `<test_depend>` | 仅测试期 | lint / pytest |
| `<group_depend>` | 依赖元包组 | 实践上 ros2 元包用 `<exec_depend>` 而非它（见 ros_base） |
| `<member_of_group>` | 声明本包属于某**生成器组**（清单内仅 `rosidl_interface_packages`；接口定义方专用） | 定义 msg/srv/action 必加（触发 rosidl 代码生成 + 注册接口索引）；与依赖标签正交，触发规则见 06 文档 |
| `<doc_depend>` | 仅文档 | 罕见 |

### 1.2 三条关键规则（决定"怎么标"的硬依据）

1. **`<depend>` ≡ build + build_export + exec**（REP-149 L717；catkin_pkg 的 `parse_package_string` 展开）。
2. **find_package 只看 build + buildtool**（`ament_cmake_auto/cmake/ament_auto_find_build_dependencies.cmake` L62-83）：
   `foreach(_dep ${PROJECT_NAME}_BUILD_DEPENDS)` + `BUILDTOOL_DEPENDS` → find_package。
   ⇒ **只标 `<exec_depend>` 的依赖不会被 find_package**，C++ include 会编译失败——消息包不能只标 exec 的硬理由。
3. **build_export_depend 是"传导"标签**（REP-149 L647-652）：你的公共头 include 了它、或 `ament_export_dependencies()` 了它，下游编译才需要。**包内 .cpp 私用、不导出 → 不需要它**。

### 1.3 官方包实例（克隆源码读 package.xml 实证）

| 案例 | 声明方式 | 说明 |
|---|---|---|
| **std_msgs**（接口包, 定义 msg） | `buildtool_depend: rosidl_default_generators`；`depend: builtin_interfaces`；`exec_depend: rosidl_default_runtime` | 生成器=buildtool、依赖接口=depend、runtime=exec |
| **demo_nodes_cpp**（节点包, 消费消息） | `build_depend: rclcpp/example_interfaces...` + `exec_depend: 同批 + launch_ros/launch_xml` | 无 build_export（不导出公共接口）；launch 类仅 exec |
| **ros_base / desktop**（元包） | 仅 `buildtool_depend: ament_cmake` + **exec_depend 列表** | 元包=exec 列表（不用 depend/group_depend） |

### 1.4 职责划分（三个正交概念，2026-09-01 修订）

| 职责 | 回答的问题 | 是否决定标签 |
|---|---|---|
| ① 包的性质（nature） | 包是**什么**（库/工具/消息包/构建工具/GUI） | ❌（仅作 UI 作用说明） |
| ② 消费形态（consumption） | 你**怎么用它**（编译期链接？运行期调用？只构建期用？） | ✅ **唯一**决定标签 |
| ③ 组声明（member_of_group） | 本包属于哪个**生成器组**（接口定义方） | 正交，见 06 文档 |

**核心纠正**：不是"包的种类决定标签"，而是"**消费形态**决定标签"。包的性质只在**消费形态唯一**时强制（纯 buildtool / 纯命令 / 纯运行支撑）；可编译期链接的库一律 depend（安全超集），不按"外观像工具"猜测。

---

## 2. 标签规则：消费形态决定（2026-09-01 修订，取代"按包种类揣测"）

| 类别 | 消费形态（判定） | 展开标签 | CMakeLists 对应 |
|---|---|---|---|
| **C1 depend（默认）** | 编译期可链接（库/客户端库/消息包使用方） | build + build_export + exec（或 `<depend>`） | find_package + target 链接 |
| **C2 buildtool** | 只构建期消费（纯构建工具/代码生成器，无法链接/运行） | `buildtool_depend` | find_package（构建期） |
| **C3 exec** | 只运行期消费（命令/launch/GUI/运行支撑/运行库/插件） | `exec_depend` | 不 find_package |
| **C4 元包/聚合** | 聚合性质（作依赖无意义） | 候选**标注/排除** | — |
| **C5 演示/教程** | 教学性质（作依赖无意义） | 候选**标注/排除** | — |

**修正要点（2026-09-01）**：
- **"包的种类决定标签"是错的**——正确是"消费形态决定标签"；包的性质只在消费形态唯一时强制（纯 buildtool → 只能构建期；纯命令/运行支撑 → 只能运行期）；
- **可链接库不按外观裁**：`rosbag2_cpp`/`rosbag2_storage`/`rosbag2_transport`/`rosbag2_compression` 是库（可编译期链接）→ **C1**（此前误归 C3 exec，已修）；
- C1 三标签是**安全超集**（即使只用运行期，多写 build/export 无害），不是"揣测用法"。

---

## 3. humble 桌面完整版清单逐包对照（用户 `ros2 pkg list` 原版）

### 3.1 C1 depend（默认三标签；普通库 / 客户端库 / 消息包使用方）— ~90 包

`action_msgs` `actionlib_msgs` `ament_index_cpp` `ament_index_python` `angles` `builtin_interfaces` `class_loader` `composition` `composition_interfaces` `cv_bridge` `diagnostic_msgs` `example_interfaces` `geometry_msgs` `image_geometry` `image_transport` `interactive_markers` `kdl_parser` `laser_geometry` `libstatistics_collector` `lifecycle` `lifecycle_msgs` `map_msgs` `message_filters` `nav_msgs` `pcl_conversions` `pcl_msgs` `pendulum_msgs` `pluginlib` `rcl` `rcl_action` `rcl_interfaces` `rcl_lifecycle` `rcl_logging_interface` `rcl_logging_spdlog` `rcl_yaml_param_parser` `rclcpp` `rclcpp_action` `rclcpp_components` `rclcpp_lifecycle` `rclpy` `rcpputils` `rcutils` `resource_retriever` `rmw` `rmw_dds_common` `rmw_fastrtps_cpp` `rmw_fastrtps_shared_cpp` `rmw_implementation` `rosbag2_interfaces` `rosgraph_msgs` `rpyutils` `rttest` `sensor_msgs` `sensor_msgs_py` `shape_msgs` `statistics_msgs` `std_msgs` `std_srvs` `stereo_msgs` `tf2` `tf2_bullet` `tf2_eigen` `tf2_eigen_kdl` `tf2_geometry_msgs` `tf2_kdl` `tf2_msgs` `tf2_py` `tf2_ros` `tf2_ros_py` `tf2_sensor_msgs` `tlsf` `tlsf_cpp` `tracetools` `trajectory_msgs` `unique_identifier_msgs` `urdf` `urdf_parser_plugin` `visualization_msgs` `rosbag2_compression` `rosbag2_cpp` `rosbag2_storage` `rosbag2_transport`

### 3.2 C2 buildtool（→ `buildtool_depend`）— ~55 包

`ament_cmake` `ament_cmake_auto` `ament_cmake_copyright` `ament_cmake_core` `ament_cmake_cppcheck` `ament_cmake_cpplint` `ament_cmake_export_definitions` `ament_cmake_export_dependencies` `ament_cmake_export_include_directories` `ament_cmake_export_interfaces` `ament_cmake_export_libraries` `ament_cmake_export_link_flags` `ament_cmake_export_targets` `ament_cmake_flake8` `ament_cmake_gen_version_h` `ament_cmake_gmock` `ament_cmake_gtest` `ament_cmake_include_directories` `ament_cmake_libraries` `ament_cmake_lint_cmake` `ament_cmake_pep257` `ament_cmake_pytest` `ament_cmake_python` `ament_cmake_ros` `ament_cmake_target_dependencies` `ament_cmake_test` `ament_cmake_uncrustify` `ament_cmake_version` `ament_cmake_xmllint` `ament_copyright` `ament_cppcheck` `ament_cpplint` `ament_flake8` `ament_lint` `ament_lint_auto` `ament_lint_cmake` `ament_lint_common` `ament_package` `ament_pep257` `ament_uncrustify` `ament_xmllint` `eigen3_cmake_module` `fastrtps_cmake_module` `python_cmake_module` `rmw_implementation_cmake` `rosidl_adapter` `rosidl_cli` `rosidl_cmake` `rosidl_default_generators` `rosidl_generator_c` `rosidl_generator_cpp` `rosidl_generator_py` `rosidl_generator_rs` `rosidl_parser` `rosidl_typesupport_fastrtps_c` `rosidl_typesupport_fastrtps_cpp` `sros2_cmake` `uncrustify_vendor`

### 3.3 C3 exec（→ `exec_depend`；运行期 / launch / CLI / GUI / vendor / runtime）— ~85 包

`console_bridge_vendor` `depthimage_to_laserscan` `domain_coordinator` `image_tools` `joy` `keyboard_handler` `launch` `launch_ros` `launch_testing` `launch_testing_ament_cmake` `launch_testing_ros` `launch_xml` `launch_yaml` `libcurl_vendor` `libyaml_vendor` `orocos_kdl_vendor` `osrf_pycommon` `pybind11_vendor` `python_orocos_kdl_vendor` `python_qt_binding` `qt_dotgraph` `qt_gui` `qt_gui_cpp` `qt_gui_py_common` `robot_state_publisher` `ros2action` `ros2bag` `ros2cli` `ros2cli_common_extensions` `ros2component` `ros2doctor` `ros2interface` `ros2launch` `ros2lifecycle` `ros2multicast` `ros2node` `ros2param` `ros2pkg` `ros2plugin` `ros2run` `ros2service` `ros2topic` `rosbag2` `rosbag2_compression_zstd` `rosbag2_py` `rosbag2_storage_default_plugins` `rosidl_default_runtime` `rosidl_runtime_c` `rosidl_runtime_cpp` `rosidl_runtime_py` `rosidl_typesupport_c` `rosidl_typesupport_cpp` `rosidl_typesupport_interface` `rosidl_typesupport_introspection_c` `rosidl_typesupport_introspection_cpp` `rqt_action` `rqt_bag` `rqt_bag_plugins` `rqt_common_plugins` `rqt_console` `rqt_graph` `rqt_gui` `rqt_gui_cpp` `rqt_gui_py` `rqt_image_view` `rqt_msg` `rqt_plot` `rqt_publisher` `rqt_py_common` `rqt_py_console` `rqt_reconfigure` `rqt_shell` `rqt_srv` `rqt_topic` `rviz2` `rviz_assimp_vendor` `rviz_common` `rviz_default_plugins` `rviz_ogre_vendor` `rviz_rendering` `sdl2_vendor` `shared_queues_vendor` `spdlog_vendor` `sqlite3_vendor` `sros2` `tango_icons_vendor` `teleop_twist_joy` `teleop_twist_keyboard` `tf2_tools` `tinyxml2_vendor` `tinyxml_vendor` `topic_monitor` `turtlesim` `yaml_cpp_vendor` `zstd_vendor`

### 3.4 C4 元包/聚合（候选标注/排除）— 7 包

`ros_base` `desktop` `ros_core` `ros_workspace` `ros_environment` `common_interfaces` `geometry2`

### 3.5 C5 演示/教程（候选标注/排除）— ~29 包

`action_tutorials_cpp` `action_tutorials_interfaces` `action_tutorials_py` `demo_nodes_cpp` `demo_nodes_cpp_native` `demo_nodes_py` `dummy_map_server` `dummy_robot_bringup` `dummy_sensors` `examples_rclcpp_minimal_action_client` `examples_rclcpp_minimal_action_server` `examples_rclcpp_minimal_client` `examples_rclcpp_minimal_composition` `examples_rclcpp_minimal_publisher` `examples_rclcpp_minimal_service` `examples_rclcpp_minimal_subscriber` `examples_rclcpp_multithreaded_executor` `examples_rclpy_executors` `examples_rclpy_minimal_action_client` `examples_rclpy_minimal_action_server` `examples_rclpy_minimal_client` `examples_rclpy_minimal_publisher` `examples_rclpy_minimal_service` `examples_rclpy_minimal_subscriber` `intra_process_demo` `logging_demo` `pendulum_control` `quality_of_service_demo_cpp` `quality_of_service_demo_py`

### 3.6 归类边界说明（2026-09-01 修订）

- **判定轴是消费形态，不是外观**：可编译期链接的库 → C1（哪怕名字像工具，如 `rosbag2_cpp`/`rosbag2_storage`/`rosbag2_transport`/`rosbag2_compression` 已从 C3 修正至 C1）；只运行期消费 → C3（命令/launch/GUI/插件/运行支撑）。
- **边界包**：`rqt_gui_cpp`/`qt_gui_cpp`/`qt_gui` 导出可链接库但消费场景基本为运行——创建流程按 C3（运行）默认可接受，若确需链接则自行改 depend；文档标注边界不硬归。
- **vendor 例外**：`uncrustify_vendor` 提供构建期工具 → C2；其余 `*_vendor` → C3（运行库/运行支撑）。
- **rosidl 拆分（生成器侧 → C2，运行侧 → C3）**：用户一般只需声明 `rosidl_default_generators`(C2) + `rosidl_default_runtime`(C3)；**接口意图的组声明（member_of_group）见 06 文档**（勾选"标配对"时自动注入）。

---

## 4. 对 create 流程的实施建议

1. **dep-catalog.ts（已落地, 2026-09-01）**：`DEP_CATALOG` 常量表(271 条, A 粒度描述, C4/C5 仅类别) + `depTagClass(dep)`(查表, 未收录兜底 depend) + `lookupDep`;
2. **生成器按类别展开（已落地, 2026-09-01）**：create-cpp-package / create-python-package 的 package.xml 按 `depTagClass` 展开——C1 → 三标签; C2 → `<buildtool_depend>`; C3/metapkg/demo → `<exec_depend>`; CMakeLists 对 C3 不 find_package;
3. **QuickPick 作用说明（已落地, 2026-09-01）**：description = `depDescription`(A 粒度一句话; C4/C5 → [元包/聚合]/[演示/教程] 标记, 标注不排除); detail = 升级/跨体系标注;
4. 分类白名单以本文件 §3 清单为基准(清单随发行版变化, 用包名模式优于硬编码名单: `*_vendor`、`ament_*`、`rosidl_generator_*`、`ros2*` 等);
5. **member_of_group 注入（已落地, 2026-09-01）**：`dep-catalog.hasInterfaceIntent` 判定标配对（生成器侧 + 运行支撑侧各 ≥1）→ 生成器自动注入 `<member_of_group>rosidl_interface_packages</member_of_group>`（决策矩阵见 06 文档）。

---

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-01 21:29 | 建档:package.xml 依赖标签研讨 + humble 桌面完整版清单逐包对照——源码验证(REP-149/ament_cmake/catkin_pkg/官方包实例)得出 5 类分类(depend/buildtool/exec/元包/演示), 列出 depTagClass 规则与 ~270 包归类;为 create 依赖多选标签分类提供依据 |
| 2026-09-01 22:43 | 修订:①§1.1 补 member_of_group(接口定义方组声明);②新增 §1.4 职责划分(性质/消费形态/组声明三正交概念)——核心纠正"包的种类决定标签"→"消费形态决定标签", 性质只在消费形态唯一时强制;③§2 重写为消费形态判定, 删除按外观揣测;④§3 修正:rosbag2_cpp/storage/transport/compression 从 C3 移至 C1(可链接库不按外观裁), rqt/qt 系标注边界;⑤§4 补 member_of_group 注入项(交叉引用 06) |
| 2026-09-01 23:57 | Phase 1 落地:dep-catalog.ts 常量表(271 条, 与 §3 清单双向零偏差, A 粒度描述, C4/C5 仅类别) + depTagClass(查表/兜底 depend) + lookupDep;新增 dep-catalog.test.ts(9 用例);§4 实施第 1 步更新 |
| 2026-09-01 23:59 | Phase 2 落地:生成器按 depTagClass 展开标签(cpp+py 两处 package.xml: buildtool_depend / 三标签 / exec_depend; CMakeLists C3 不 find_package);新增 2 个分类展开测试;全量 168 用例通过 |
| 2026-09-02 00:03 | Phase 3 落地:member_of_group 标配对注入(INTERFACE_GENERATOR_SIDE/RUNTIME_SIDE/hasInterfaceIntent 入 dep-catalog, 两生成器 package.xml 自动注入);新增 6 测试;全量 174 用例通过 |
| 2026-09-02 00:04 | Phase 4 落地:dep-catalog.depDescription(A 粒度作用说明, C4/C5 类别标记), dep-pick.pickMulti description/detail 分工(作用说明 + 升级跨体系标注);新增 4 测试;全量 178 用例通过 |
