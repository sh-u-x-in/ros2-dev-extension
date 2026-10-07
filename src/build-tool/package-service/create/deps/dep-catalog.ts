// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from 'vscode'; // 2026-10-04 i18n 期2

/**
 * @file dep-catalog.ts
 * 依赖目录常量表(2026-09-01, 依据 05-包依赖标签研讨与humble清单对照.md §3)。
 *
 * 覆盖:用户 humble 桌面完整版 `ros2 pkg list` 全量清单(~270 包)。
 * 语义:
 *   - cls 消费形态类别: depend(编译期可链接)/ buildtool(只构建期)/ exec(只运行期)/
 *                      metapkg(元包, C4)/ demo(演示教程, C5);
 *   - desc 作用说明(A 粒度, 一句话; C4/C5 不写——它们只作标注/排除, 不参与选择);
 *   - 未收录的包(未来发行版新增)由 depTagClass 兜底为 depend(安全超集)。
 *
 * 纯数据, 零依赖, 可单测。
 */

/** 消费形态类别(05 文档 §2) */
export type DepClass = 'depend' | 'buildtool' | 'exec' | 'metapkg' | 'demo';

/** 单包条目: 类别(必填) + 作用说明(A 粒度, C4/C5 省略) */
export interface DepInfo {
    cls: DepClass;
    desc?: string;
}

/** 依赖目录: 包名 → {类别, 作用说明} */
export const DEP_CATALOG: Record<string, DepInfo> = {
    // ── C1 depend: 编译期可链接(库/客户端库/消息包使用方) ──
    'action_msgs': { cls: 'depend', desc: l10n.t('Action message definitions (action_msgs)') },
    'actionlib_msgs': { cls: 'depend', desc: l10n.t('Action library message definitions') },
    'ament_index_cpp': { cls: 'depend', desc: l10n.t('ament index C++ library (query installed resources)') },
    'ament_index_python': { cls: 'depend', desc: l10n.t('ament index Python library') },
    'angles': { cls: 'depend', desc: l10n.t('angle utility library (normalization/radian conversion)') },
    'builtin_interfaces': { cls: 'depend', desc: l10n.t('ROS built-in primitive messages (Time/Duration)') },
    'class_loader': { cls: 'depend', desc: l10n.t('Runtime plugin dynamic loading library') },
    'composition': { cls: 'depend', desc: l10n.t('Node composition library (intra-process multi-node)') },
    'composition_interfaces': { cls: 'depend', desc: l10n.t('Node composition service message definitions') },
    'cv_bridge': { cls: 'depend', desc: l10n.t('OpenCV <-> ROS image message conversion') },
    'diagnostic_msgs': { cls: 'depend', desc: l10n.t('Diagnostic message definitions') },
    'example_interfaces': { cls: 'depend', desc: l10n.t('Example message/service/action definitions') },
    'geometry_msgs': { cls: 'depend', desc: l10n.t('Geometry message definitions (pose/vector/transform)') },
    'image_geometry': { cls: 'depend', desc: l10n.t('Image geometry library (camera models/distortion)') },
    'image_transport': { cls: 'depend', desc: l10n.t('Image transport abstraction (compression/transport plugins)') },
    'interactive_markers': { cls: 'depend', desc: l10n.t('Interactive 3D marker library') },
    'kdl_parser': { cls: 'depend', desc: l10n.t('URDF -> KDL kinematic tree parsing library') },
    'laser_geometry': { cls: 'depend', desc: l10n.t('Laser data geometry utility library') },
    'libstatistics_collector': { cls: 'depend', desc: l10n.t('QoS statistics collection library') },
    'lifecycle': { cls: 'depend', desc: l10n.t('Lifecycle node implementation library') },
    'lifecycle_msgs': { cls: 'depend', desc: l10n.t('Lifecycle message definitions') },
    'map_msgs': { cls: 'depend', desc: l10n.t('Map message definitions') },
    'message_filters': { cls: 'depend', desc: l10n.t('Message synchronization/time-aligned filter library') },
    'nav_msgs': { cls: 'depend', desc: l10n.t('Navigation message definitions (odometry/path/map)') },
    'pcl_conversions': { cls: 'depend', desc: l10n.t('PCL <-> ROS point cloud message conversion') },
    'pcl_msgs': { cls: 'depend', desc: l10n.t('PCL message definitions') },
    'pendulum_msgs': { cls: 'depend', desc: l10n.t('Pendulum control demo message definitions') },
    'pluginlib': { cls: 'depend', desc: l10n.t('Plugin loading framework (C++ shared library plugins)') },
    'rcl': { cls: 'depend', desc: l10n.t('ROS client library base layer (C API)') },
    'rcl_action': { cls: 'depend', desc: l10n.t('Action client/server C API') },
    'rcl_interfaces': { cls: 'depend', desc: l10n.t('Core interface message definitions') },
    'rcl_lifecycle': { cls: 'depend', desc: l10n.t('Lifecycle C API') },
    'rcl_logging_interface': { cls: 'depend', desc: l10n.t('Logging backend interface') },
    'rcl_logging_spdlog': { cls: 'depend', desc: l10n.t('spdlog logging backend implementation') },
    'rcl_yaml_param_parser': { cls: 'depend', desc: l10n.t('YAML parameter parsing library') },
    'rclcpp': { cls: 'depend', desc: l10n.t('ROS 2 C++ client library') },
    'rclcpp_action': { cls: 'depend', desc: l10n.t('C++ action API') },
    'rclcpp_components': { cls: 'depend', desc: l10n.t('C++ composable node library') },
    'rclcpp_lifecycle': { cls: 'depend', desc: l10n.t('C++ lifecycle node API') },
    'rclpy': { cls: 'depend', desc: l10n.t('ROS 2 Python client library') },
    'rcpputils': { cls: 'depend', desc: l10n.t('C++ common utility library') },
    'rcutils': { cls: 'depend', desc: l10n.t('C common utility library') },
    'resource_retriever': { cls: 'depend', desc: l10n.t('Resource retrieval library (URLs/in-package files)') },
    'rmw': { cls: 'depend', desc: l10n.t('Middleware abstraction interface (RMW)') },
    'rmw_dds_common': { cls: 'depend', desc: l10n.t('DDS middleware common implementation') },
    'rmw_fastrtps_cpp': { cls: 'depend', desc: l10n.t('Fast DDS middleware implementation (C++)') },
    'rmw_fastrtps_shared_cpp': { cls: 'depend', desc: l10n.t('Fast DDS shared implementation') },
    'rmw_implementation': { cls: 'depend', desc: l10n.t('Default rmw implementation selection library') },
    'rosbag2_interfaces': { cls: 'depend', desc: l10n.t('rosbag2 message definitions') },
    'rosbag2_compression': { cls: 'depend', desc: l10n.t('rosbag2 compression library') },
    'rosbag2_cpp': { cls: 'depend', desc: l10n.t('rosbag2 C++ read/write library') },
    'rosbag2_storage': { cls: 'depend', desc: l10n.t('rosbag2 storage backend interface') },
    'rosbag2_transport': { cls: 'depend', desc: l10n.t('rosbag2 transport/playback API') },
    'rosgraph_msgs': { cls: 'depend', desc: l10n.t('ROS graph message definitions (clock etc.)') },
    'rpyutils': { cls: 'depend', desc: l10n.t('ROS Python utility library') },
    'rttest': { cls: 'depend', desc: l10n.t('Real-time testing statistics library') },
    'sensor_msgs': { cls: 'depend', desc: l10n.t('Sensor message definitions (image/laser/IMU)') },
    'sensor_msgs_py': { cls: 'depend', desc: l10n.t('Sensor message Python helpers') },
    'shape_msgs': { cls: 'depend', desc: l10n.t('Shape message definitions') },
    'statistics_msgs': { cls: 'depend', desc: l10n.t('Statistics message definitions') },
    'std_msgs': { cls: 'depend', desc: l10n.t('Standard message definitions (primitive types)') },
    'std_srvs': { cls: 'depend', desc: l10n.t('Standard service definitions (empty/trigger)') },
    'stereo_msgs': { cls: 'depend', desc: l10n.t('Stereo vision message definitions') },
    'tf2': { cls: 'depend', desc: l10n.t('tf2 core library (coordinate transforms)') },
    'tf2_bullet': { cls: 'depend', desc: l10n.t('tf2 + Bullet physics conversion') },
    'tf2_eigen': { cls: 'depend', desc: l10n.t('tf2 + Eigen conversion') },
    'tf2_eigen_kdl': { cls: 'depend', desc: l10n.t('tf2 Eigen/KDL bridge') },
    'tf2_geometry_msgs': { cls: 'depend', desc: l10n.t('tf2 + geometry_msgs conversion') },
    'tf2_kdl': { cls: 'depend', desc: l10n.t('tf2 + KDL conversion') },
    'tf2_msgs': { cls: 'depend', desc: l10n.t('tf2 message definitions') },
    'tf2_py': { cls: 'depend', desc: l10n.t('tf2 Python interface') },
    'tf2_ros': { cls: 'depend', desc: l10n.t('tf2 ROS interface (broadcaster/listener)') },
    'tf2_ros_py': { cls: 'depend', desc: l10n.t('tf2_ros Python version') },
    'tf2_sensor_msgs': { cls: 'depend', desc: l10n.t('tf2 + sensor_msgs conversion') },
    'tlsf': { cls: 'depend', desc: l10n.t('Real-time allocator (TLSF)') },
    'tlsf_cpp': { cls: 'depend', desc: l10n.t('TLSF C++ wrapper') },
    'tracetools': { cls: 'depend', desc: l10n.t('Tracing/profiling tool library') },
    'trajectory_msgs': { cls: 'depend', desc: l10n.t('Trajectory message definitions') },
    'unique_identifier_msgs': { cls: 'depend', desc: l10n.t('UUID message definitions') },
    'urdf': { cls: 'depend', desc: l10n.t('URDF parsing library') },
    'urdf_parser_plugin': { cls: 'depend', desc: l10n.t('URDF parser plugin interface') },
    'visualization_msgs': { cls: 'depend', desc: l10n.t('Visualization message definitions (Marker etc.)') },
    // ── C2 buildtool: 只构建期消费(构建工具/代码生成器) ──
    'ament_cmake': { cls: 'buildtool', desc: l10n.t('ament build system (CMake integration)') },
    'ament_cmake_auto': { cls: 'buildtool', desc: l10n.t('Automatic find_package macro') },
    'ament_cmake_copyright': { cls: 'buildtool', desc: l10n.t('Copyright check test macro') },
    'ament_cmake_core': { cls: 'buildtool', desc: l10n.t('ament build core macros') },
    'ament_cmake_cppcheck': { cls: 'buildtool', desc: l10n.t('cppcheck static analysis integration') },
    'ament_cmake_cpplint': { cls: 'buildtool', desc: l10n.t('cpplint check integration') },
    'ament_cmake_export_definitions': { cls: 'buildtool', desc: l10n.t('Export compile definition macro') },
    'ament_cmake_export_dependencies': { cls: 'buildtool', desc: l10n.t('Export dependency macro (propagates find_package)') },
    'ament_cmake_export_include_directories': { cls: 'buildtool', desc: l10n.t('Export include directory macro') },
    'ament_cmake_export_interfaces': { cls: 'buildtool', desc: l10n.t('Export CMake interface macro') },
    'ament_cmake_export_libraries': { cls: 'buildtool', desc: l10n.t('Export library macro') },
    'ament_cmake_export_link_flags': { cls: 'buildtool', desc: l10n.t('Export link flag macro') },
    'ament_cmake_export_targets': { cls: 'buildtool', desc: l10n.t('Export target macro') },
    'ament_cmake_flake8': { cls: 'buildtool', desc: l10n.t('flake8 check integration') },
    'ament_cmake_gen_version_h': { cls: 'buildtool', desc: l10n.t('Generate version header macro') },
    'ament_cmake_gmock': { cls: 'buildtool', desc: l10n.t('gmock test integration') },
    'ament_cmake_gtest': { cls: 'buildtool', desc: l10n.t('gtest test integration') },
    'ament_cmake_include_directories': { cls: 'buildtool', desc: l10n.t('include directory handling macro') },
    'ament_cmake_libraries': { cls: 'buildtool', desc: l10n.t('Library handling macro') },
    'ament_cmake_lint_cmake': { cls: 'buildtool', desc: l10n.t('CMake lint integration') },
    'ament_cmake_pep257': { cls: 'buildtool', desc: l10n.t('pep257 check integration') },
    'ament_cmake_pytest': { cls: 'buildtool', desc: l10n.t('pytest test integration') },
    'ament_cmake_python': { cls: 'buildtool', desc: l10n.t('Python module install macro (ament_python_install_package)') },
    'ament_cmake_ros': { cls: 'buildtool', desc: l10n.t('ROS-specific ament extensions') },
    'ament_cmake_target_dependencies': { cls: 'buildtool', desc: l10n.t('target dependency binding macro') },
    'ament_cmake_test': { cls: 'buildtool', desc: l10n.t('Test framework integration') },
    'ament_cmake_uncrustify': { cls: 'buildtool', desc: l10n.t('uncrustify format check integration') },
    'ament_cmake_version': { cls: 'buildtool', desc: l10n.t('Version info macro') },
    'ament_cmake_xmllint': { cls: 'buildtool', desc: l10n.t('XML lint integration') },
    'ament_copyright': { cls: 'buildtool', desc: l10n.t('Copyright check tool') },
    'ament_cppcheck': { cls: 'buildtool', desc: l10n.t('cppcheck wrapper tool') },
    'ament_cpplint': { cls: 'buildtool', desc: l10n.t('cpplint wrapper tool') },
    'ament_flake8': { cls: 'buildtool', desc: l10n.t('flake8 wrapper tool') },
    'ament_lint': { cls: 'buildtool', desc: l10n.t('lint common framework') },
    'ament_lint_auto': { cls: 'buildtool', desc: l10n.t('Automatic lint test discovery') },
    'ament_lint_cmake': { cls: 'buildtool', desc: l10n.t('CMake lint tool') },
    'ament_lint_common': { cls: 'buildtool', desc: l10n.t('Common lint dependency collection') },
    'ament_package': { cls: 'buildtool', desc: l10n.t('ament package infrastructure (config/index generation)') },
    'ament_pep257': { cls: 'buildtool', desc: l10n.t('pep257 wrapper tool') },
    'ament_uncrustify': { cls: 'buildtool', desc: l10n.t('uncrustify wrapper tool') },
    'ament_xmllint': { cls: 'buildtool', desc: l10n.t('xmllint wrapper tool') },
    'eigen3_cmake_module': { cls: 'buildtool', desc: l10n.t('Eigen3 CMake module') },
    'fastrtps_cmake_module': { cls: 'buildtool', desc: l10n.t('Fast DDS CMake module') },
    'python_cmake_module': { cls: 'buildtool', desc: l10n.t('Python CMake module') },
    'rmw_implementation_cmake': { cls: 'buildtool', desc: l10n.t('rmw implementation selection CMake macro') },
    'rosidl_adapter': { cls: 'buildtool', desc: l10n.t('Interface definition adapter (msg/srv/action parsing)') },
    'rosidl_cli': { cls: 'buildtool', desc: l10n.t('rosidl CLI tool') },
    'rosidl_cmake': { cls: 'buildtool', desc: l10n.t('rosidl CMake macros (interface generation)') },
    'rosidl_default_generators': { cls: 'buildtool', desc: l10n.t('Default language generator collection (required for interface packages)') },
    'rosidl_generator_c': { cls: 'buildtool', desc: l10n.t('C code generator') },
    'rosidl_generator_cpp': { cls: 'buildtool', desc: l10n.t('C++ code generator') },
    'rosidl_generator_py': { cls: 'buildtool', desc: l10n.t('Python code generator') },
    'rosidl_generator_rs': { cls: 'buildtool', desc: l10n.t('Rust code generator') },
    'rosidl_parser': { cls: 'buildtool', desc: l10n.t('Interface definition parser') },
    'rosidl_typesupport_fastrtps_c': { cls: 'buildtool', desc: l10n.t('Fast DDS typesupport generation (C)') },
    'rosidl_typesupport_fastrtps_cpp': { cls: 'buildtool', desc: l10n.t('Fast DDS typesupport generation (C++)') },
    'sros2_cmake': { cls: 'buildtool', desc: l10n.t('SROS2 security CMake integration') },
    'uncrustify_vendor': { cls: 'buildtool', desc: l10n.t('uncrustify formatter (vendored)') },
    // ── C3 exec: 只运行期消费(命令/launch/GUI/运行支撑/运行库/插件) ──
    'console_bridge_vendor': { cls: 'exec', desc: l10n.t('console_bridge console library (vendored)') },
    'depthimage_to_laserscan': { cls: 'exec', desc: l10n.t('Depth image to laser scan node') },
    'domain_coordinator': { cls: 'exec', desc: l10n.t('ROS domain coordination tool') },
    'image_tools': { cls: 'exec', desc: l10n.t('Image publish/display demo tools') },
    'joy': { cls: 'exec', desc: l10n.t('Joystick input driver node') },
    'keyboard_handler': { cls: 'exec', desc: l10n.t('Keyboard input tool') },
    'launch': { cls: 'exec', desc: l10n.t('launch framework (Python)') },
    'launch_ros': { cls: 'exec', desc: l10n.t('ROS launch extensions') },
    'launch_testing': { cls: 'exec', desc: l10n.t('launch testing framework') },
    'launch_testing_ament_cmake': { cls: 'exec', desc: l10n.t('launch testing CMake integration') },
    'launch_testing_ros': { cls: 'exec', desc: l10n.t('ROS launch test extensions') },
    'launch_xml': { cls: 'exec', desc: l10n.t('launch XML parsing') },
    'launch_yaml': { cls: 'exec', desc: l10n.t('launch YAML parsing') },
    'libcurl_vendor': { cls: 'exec', desc: l10n.t('libcurl networking library (vendored)') },
    'libyaml_vendor': { cls: 'exec', desc: l10n.t('libyaml parsing library (vendored)') },
    'orocos_kdl_vendor': { cls: 'exec', desc: l10n.t('KDL kinematics library (vendored)') },
    'osrf_pycommon': { cls: 'exec', desc: l10n.t('OSRF Python common utilities') },
    'pybind11_vendor': { cls: 'exec', desc: l10n.t('pybind11 binding library (vendored)') },
    'python_orocos_kdl_vendor': { cls: 'exec', desc: l10n.t('Python KDL bindings (vendored)') },
    'python_qt_binding': { cls: 'exec', desc: l10n.t('Qt Python bindings (shiboken)') },
    'qt_dotgraph': { cls: 'exec', desc: l10n.t('Qt point/plot and graph tools') },
    'qt_gui': { cls: 'exec', desc: l10n.t('Qt GUI framework (plugin-based)') },
    'qt_gui_cpp': { cls: 'exec', desc: l10n.t('Qt GUI C++ bindings') },
    'qt_gui_py_common': { cls: 'exec', desc: l10n.t('Qt GUI Python common module') },
    'robot_state_publisher': { cls: 'exec', desc: l10n.t('Robot state publisher node (URDF -> tf)') },
    'ros2action': { cls: 'exec', desc: l10n.t('action CLI tool') },
    'ros2bag': { cls: 'exec', desc: l10n.t('rosbag CLI tool (record/playback)') },
    'ros2cli': { cls: 'exec', desc: l10n.t('ros2 CLI base framework') },
    'ros2cli_common_extensions': { cls: 'exec', desc: l10n.t('ros2 CLI extension collection') },
    'ros2component': { cls: 'exec', desc: l10n.t('component CLI tool') },
    'ros2doctor': { cls: 'exec', desc: l10n.t('Environment diagnostic tool') },
    'ros2interface': { cls: 'exec', desc: l10n.t('interface query CLI tool') },
    'ros2launch': { cls: 'exec', desc: l10n.t('launch CLI tool') },
    'ros2lifecycle': { cls: 'exec', desc: l10n.t('lifecycle CLI tool') },
    'ros2multicast': { cls: 'exec', desc: l10n.t('Multicast discovery test tool') },
    'ros2node': { cls: 'exec', desc: l10n.t('node query CLI tool') },
    'ros2param': { cls: 'exec', desc: l10n.t('parameter CLI tool') },
    'ros2pkg': { cls: 'exec', desc: l10n.t('package query CLI tool') },
    'ros2plugin': { cls: 'exec', desc: l10n.t('plugin query CLI tool') },
    'ros2run': { cls: 'exec', desc: l10n.t('run node CLI tool') },
    'ros2service': { cls: 'exec', desc: l10n.t('service CLI tool') },
    'ros2topic': { cls: 'exec', desc: l10n.t('topic CLI tool') },
    'rosbag2': { cls: 'exec', desc: l10n.t('rosbag2 applications/tools collection') },
    'rosbag2_compression_zstd': { cls: 'exec', desc: l10n.t('rosbag2 zstd compression plugin') },
    'rosbag2_py': { cls: 'exec', desc: l10n.t('rosbag2 Python API') },
    'rosbag2_storage_default_plugins': { cls: 'exec', desc: l10n.t('rosbag2 default storage plugin (SQLite)') },
    'rosidl_default_runtime': { cls: 'exec', desc: l10n.t('Default runtime typesupport collection (required for interface packages)') },
    'rosidl_runtime_c': { cls: 'exec', desc: l10n.t('Message runtime C library') },
    'rosidl_runtime_cpp': { cls: 'exec', desc: l10n.t('Message runtime C++ library') },
    'rosidl_runtime_py': { cls: 'exec', desc: l10n.t('Message runtime Python library') },
    'rosidl_typesupport_c': { cls: 'exec', desc: l10n.t('C typesupport runtime') },
    'rosidl_typesupport_cpp': { cls: 'exec', desc: l10n.t('C++ typesupport runtime') },
    'rosidl_typesupport_interface': { cls: 'exec', desc: l10n.t('typesupport interface macros') },
    'rosidl_typesupport_introspection_c': { cls: 'exec', desc: l10n.t('C introspection typesupport') },
    'rosidl_typesupport_introspection_cpp': { cls: 'exec', desc: l10n.t('C++ introspection typesupport') },
    'rqt_action': { cls: 'exec', desc: l10n.t('rqt action plugin') },
    'rqt_bag': { cls: 'exec', desc: l10n.t('rqt bag playback plugin') },
    'rqt_bag_plugins': { cls: 'exec', desc: l10n.t('rqt_bag plugin extensions') },
    'rqt_common_plugins': { cls: 'exec', desc: l10n.t('rqt common plugin collection') },
    'rqt_console': { cls: 'exec', desc: l10n.t('rqt console (log view) plugin') },
    'rqt_graph': { cls: 'exec', desc: l10n.t('rqt graph visualization plugin') },
    'rqt_gui': { cls: 'exec', desc: l10n.t('rqt GUI framework') },
    'rqt_gui_cpp': { cls: 'exec', desc: l10n.t('rqt GUI C++ bindings') },
    'rqt_gui_py': { cls: 'exec', desc: l10n.t('rqt GUI Python bindings') },
    'rqt_image_view': { cls: 'exec', desc: l10n.t('rqt image view plugin') },
    'rqt_msg': { cls: 'exec', desc: l10n.t('rqt message viewer plugin') },
    'rqt_plot': { cls: 'exec', desc: l10n.t('rqt plot plugin') },
    'rqt_publisher': { cls: 'exec', desc: l10n.t('rqt message publisher plugin') },
    'rqt_py_common': { cls: 'exec', desc: l10n.t('rqt Python common module') },
    'rqt_py_console': { cls: 'exec', desc: l10n.t('rqt Python console plugin') },
    'rqt_reconfigure': { cls: 'exec', desc: l10n.t('rqt dynamic reconfigure plugin') },
    'rqt_shell': { cls: 'exec', desc: l10n.t('rqt terminal plugin') },
    'rqt_srv': { cls: 'exec', desc: l10n.t('rqt service caller plugin') },
    'rqt_topic': { cls: 'exec', desc: l10n.t('rqt topic monitor plugin') },
    'rviz2': { cls: 'exec', desc: l10n.t('RViz2 3D visualization tool') },
    'rviz_assimp_vendor': { cls: 'exec', desc: l10n.t('Assimp 3D model library (vendored)') },
    'rviz_common': { cls: 'exec', desc: l10n.t('RViz2 common library') },
    'rviz_default_plugins': { cls: 'exec', desc: l10n.t('RViz2 default plugins') },
    'rviz_ogre_vendor': { cls: 'exec', desc: l10n.t('OGRE rendering engine (vendored)') },
    'rviz_rendering': { cls: 'exec', desc: l10n.t('RViz2 rendering library') },
    'sdl2_vendor': { cls: 'exec', desc: l10n.t('SDL2 library (vendored)') },
    'shared_queues_vendor': { cls: 'exec', desc: l10n.t('Shared queue library (vendored)') },
    'spdlog_vendor': { cls: 'exec', desc: l10n.t('spdlog logging library (vendored)') },
    'sqlite3_vendor': { cls: 'exec', desc: l10n.t('SQLite library (vendored)') },
    'sros2': { cls: 'exec', desc: l10n.t('ROS 2 security tools (encryption/permissions)') },
    'tango_icons_vendor': { cls: 'exec', desc: l10n.t('Tango icon set (vendored)') },
    'teleop_twist_joy': { cls: 'exec', desc: l10n.t('Joystick -> cmd_vel teleop node') },
    'teleop_twist_keyboard': { cls: 'exec', desc: l10n.t('Keyboard -> cmd_vel teleop node') },
    'tf2_tools': { cls: 'exec', desc: l10n.t('tf2 CLI tool (echo/monitor)') },
    'tinyxml2_vendor': { cls: 'exec', desc: l10n.t('TinyXML2 parsing library (vendored)') },
    'tinyxml_vendor': { cls: 'exec', desc: l10n.t('TinyXML parsing library (vendored)') },
    'topic_monitor': { cls: 'exec', desc: l10n.t('topic monitor tool') },
    'turtlesim': { cls: 'exec', desc: l10n.t('Turtlesim demo') },
    'yaml_cpp_vendor': { cls: 'exec', desc: l10n.t('yaml-cpp parsing library (vendored)') },
    'zstd_vendor': { cls: 'exec', desc: l10n.t('Zstandard compression library (vendored)') },
    // ── C4 元包/聚合(只标注/排除, 不写描述) ──
    'ros_base': { cls: 'metapkg' },
    'desktop': { cls: 'metapkg' },
    'ros_core': { cls: 'metapkg' },
    'ros_workspace': { cls: 'metapkg' },
    'ros_environment': { cls: 'metapkg' },
    'common_interfaces': { cls: 'metapkg' },
    'geometry2': { cls: 'metapkg' },
    // ── C5 演示/教程(只标注/排除, 不写描述) ──
    'action_tutorials_cpp': { cls: 'demo' },
    'action_tutorials_interfaces': { cls: 'demo' },
    'action_tutorials_py': { cls: 'demo' },
    'demo_nodes_cpp': { cls: 'demo' },
    'demo_nodes_cpp_native': { cls: 'demo' },
    'demo_nodes_py': { cls: 'demo' },
    'dummy_map_server': { cls: 'demo' },
    'dummy_robot_bringup': { cls: 'demo' },
    'dummy_sensors': { cls: 'demo' },
    'examples_rclcpp_minimal_action_client': { cls: 'demo' },
    'examples_rclcpp_minimal_action_server': { cls: 'demo' },
    'examples_rclcpp_minimal_client': { cls: 'demo' },
    'examples_rclcpp_minimal_composition': { cls: 'demo' },
    'examples_rclcpp_minimal_publisher': { cls: 'demo' },
    'examples_rclcpp_minimal_service': { cls: 'demo' },
    'examples_rclcpp_minimal_subscriber': { cls: 'demo' },
    'examples_rclcpp_multithreaded_executor': { cls: 'demo' },
    'examples_rclpy_executors': { cls: 'demo' },
    'examples_rclpy_minimal_action_client': { cls: 'demo' },
    'examples_rclpy_minimal_action_server': { cls: 'demo' },
    'examples_rclpy_minimal_client': { cls: 'demo' },
    'examples_rclpy_minimal_publisher': { cls: 'demo' },
    'examples_rclpy_minimal_service': { cls: 'demo' },
    'examples_rclpy_minimal_subscriber': { cls: 'demo' },
    'intra_process_demo': { cls: 'demo' },
    'logging_demo': { cls: 'demo' },
    'pendulum_control': { cls: 'demo' },
    'quality_of_service_demo_cpp': { cls: 'demo' },
    'quality_of_service_demo_py': { cls: 'demo' },
};

/** 目录内条目数(调试/单测用) */
export const DEP_CATALOG_SIZE = Object.keys(DEP_CATALOG).length;

/**
 * 查目录:命中返回条目;未命中返回 null(调用方兜底 depend)。
 */
export function lookupDep(dep: string): DepInfo | null {
    return DEP_CATALOG[dep] ?? null;
}

/**
 * 消费形态分类(05 文档 §2 / 06 文档, Phase 1 实施):
 *   - 目录命中 → 对应类别;
 *   - 未命中(未来发行版新增包) → 'depend'(安全超集: 可链接即三标签, 不猜用法)。
 * 供生成器按类展开标签(C1 三标签 / C2 buildtool_depend / C3 exec_depend)与 member_of_group 标配对判定使用。
 */
export function depTagClass(dep: string): DepClass {
    return DEP_CATALOG[dep]?.cls ?? 'depend';
}

// ---------------------------------------------------------------------------
// 纯 Python 包名单(2026-09-06 知识修订)
// ---------------------------------------------------------------------------
// 判定来源: 包自身 package.xml 的 <build_type> 才是权威(工作区包经 package-core 携带,
// 见 deps/dep-lang.ts); 系统包(/opt/ros)目录表**补录已知纯 Python** 者 ——
// 它们无 CMake 导出: C++ 侧不可 find_package、不可三标签, 仅 Python 侧可 import。

/** 目录表内已知"纯 Python(ament_python, 无 CMake 导出)"的系统包 */
export const KNOWN_PYTHON_ONLY: readonly string[] = [
    'ament_index_python',   // ament 索引 Python 库
    'rclpy',                // ROS 2 Python 客户端库
    'rpyutils',             // ROS Python 工具库
    'sensor_msgs_py',       // 传感器消息 Python 辅助
    'tf2_py',               // tf2 Python 接口
    'tf2_ros_py',           // tf2_ros Python 版
];

/** 查已知纯 Python 名单(仅系统包兜底用; 工作区包以 package.xml build_type 为准) */
export function isKnownPythonOnly(dep: string): boolean {
    return KNOWN_PYTHON_ONLY.includes(dep);
}

// ---------------------------------------------------------------------------
// 接口意图(06 文档 §2): member_of_group 标配对判定
// ---------------------------------------------------------------------------

/** 接口"生成器侧"包(勾选信号 A; 清单内 11 个, 06 文档 §2) */
export const INTERFACE_GENERATOR_SIDE: readonly string[] = [
    'rosidl_default_generators', 'rosidl_generator_c', 'rosidl_generator_cpp', 'rosidl_generator_py',
    'rosidl_generator_rs', 'rosidl_typesupport_fastrtps_c', 'rosidl_typesupport_fastrtps_cpp',
    'rosidl_cmake', 'rosidl_adapter', 'rosidl_parser', 'rosidl_cli',
];

/** 接口"运行支撑侧"包(勾选信号 B; 清单内 9 个, 06 文档 §2) */
export const INTERFACE_RUNTIME_SIDE: readonly string[] = [
    'rosidl_default_runtime', 'rosidl_runtime_c', 'rosidl_runtime_cpp', 'rosidl_runtime_py',
    'rosidl_typesupport_c', 'rosidl_typesupport_cpp', 'rosidl_typesupport_interface',
    'rosidl_typesupport_introspection_c', 'rosidl_typesupport_introspection_cpp',
];

/**
 * 接口意图判定(06 文档 §3 决策矩阵 #1-3): 勾选同时含"生成器侧 ≥1"且"运行支撑侧 ≥1" → 成立。
 * 成立 → 生成器自动注入 `<member_of_group>rosidl_interface_packages</member_of_group>`。
 * 半对(只一侧)/只勾消息包(使用≠定义) → 不成立。
 */
export function hasInterfaceIntent(deps: readonly string[]): boolean {
    return deps.some((d) => INTERFACE_GENERATOR_SIDE.includes(d))
        && deps.some((d) => INTERFACE_RUNTIME_SIDE.includes(d));
}

/**
 * QuickPick 作用说明(Phase 4, A 粒度):
 *   - 目录命中且有 desc → 返回一句话作用(C1/C2/C3);
 *   - C4 元包/聚合 → "[元包/聚合]"(无 desc, 类别标记);
 *   - C5 演示/教程 → "[演示/教程]";
 *   - 未收录(未来新包) → undefined(无说明, 不标注)。
 */
export function depDescription(dep: string): string | undefined {
    const info = DEP_CATALOG[dep];
    if (!info) {
        return undefined;
    }
    if (info.desc) {
        return info.desc;
    }
    if (info.cls === 'metapkg') {
        return '[元包/聚合]';
    }
    if (info.cls === 'demo') {
        return '[演示/教程]';
    }
    return undefined;
}
