# xacro / URDF 样例(轮式移动机器人)

> 用途:演示 RDE-ROS-2 扩展的 **xacro 编辑能力**(IncludeGraph 跳转 / hover / 补全 / D1-D14 诊断),并作为**真实文件集成验证**样例。
> 设计原则:对齐真实机器人项目(TurtleBot3 风格),**足够复杂**以覆盖各功能点。

## 结构

```
xacro/
├── robot.urdf.xacro              # 主入口:include 各模块 + property/arg + 组装
├── description/
│   ├── materials.urdf.xacro      # 材质宏(可复用 material)
│   ├── base.urdf.xacro           # 底盘宏 + 轮子宏(含 inertial/geometry/joint)
│   └── sensors.urdf.xacro        # 激光/相机宏(含 mesh 引用)
├── urdf/
│   └── base_plate.urdf           # 纯 URDF 文件(被主文件 include)
├── config/
│   └── gazebo.urdf.xacro         # gazebo 仿真插件宏(条件 include)
└── grammar/                      # XG11 语法夹具(2026-09-25,Tier1+Tier2 构造全覆盖)
    ├── grammar_showcase.urdf.xacro  # 宏参数全家桶/insert_block/递归宏/xacro:call/if-unless/ns include/glob include
    ├── ns_parts.urdf.xacro       # ns= include 目标(drv. 点访问)
    ├── parts/p_left.xacro        # glob include 枚举目标(之一)
    ├── parts/p_right.xacro       # glob include 枚举目标(之二)
    └── props.yaml                # load_yaml 点访问目标
```

## 覆盖的功能点

| 功能 | 样例位置 |
|:--|:--|
| 多层 include 链 | `robot.urdf.xacro` → `description/*` → `urdf/base_plate.urdf` |
| 纯 URDF 被 include | `robot.urdf.xacro` include `urdf/base_plate.urdf` |
| 宏定义 + 参数 | `base_macro`/`wheel_macro`/`laser_macro`/`camera_macro`(`params=`) |
| 宏参数全家桶(XG11) | `grammar/show_macro`:`prefix`/`name:=part`/`scale:=^|1.0`/`*origin`/`**extra` |
| 宏调用展开 | 主文件多次调用 `wheel_macro`(left/right);showcase 调用 `show_macro` |
| insert_block | `grammar/showcase` 块属性 `default_origin` + 宏内 `*origin` 插入 |
| 递归宏(XG11) | `grammar/count_to`(官方无循环语法,递归替代) |
| 动态调用(XG11) | `grammar/showcase` 的 `xacro:call macro="show_macro"` |
| property 常量 | `base_length`/`wheel_radius`/`total_mass` 等 + `${...}` 引用 |
| 列表/格式化/YAML(XG11) | `grammar/showcase`:`${joints[0]}`、`'%03d'`、`load_yaml('props.yaml')` 点访问 |
| arg 命令行参数 | `use_gazebo`/`robot_namespace` + `${arg_name}` 引用 + `<xacro:if>` 条件 |
| ns 命名空间(XG11) | `grammar/showcase` include `ns_parts` ns="drv" → `${drv.ns_radius}` / `xacro:drv.ns_macro` |
| glob include(XG11) | `grammar/showcase` include `parts/*.xacro`(sorted 枚举) |
| `$(find pkg)` 包引用 | `sensors` 相机 mesh `$(find rde_ros_2)/samples/xacro/meshes/...` |
| `package://` 引用 | `base_plate.urdf` 的 mesh `package://rde_ros_2/...` |
| link/joint 结构 | parent/child/axis/limit/dynamics/origin(完整关节) |
| inertial/mass/inertia | 底盘/轮子惯性 |
| 材质复用 | `rde_blue`/`rde_dark` 宏 + `<material>` 引用 |
| 条件编译 | `<xacro:if value="${use_gazebo}">` include gazebo 配置 |

## 说明

- mesh 文件(`meshes/*.stl|dae`)为占位引用,未随样例提供二进制(仅演示 `$(find)`/`package://` 路径解析)。
- `$(find rde_ros_2)` 包名对应本扩展工作区;在其他环境打开时 mesh 路径解析会报 D2(包未找到)——这正是诊断功能的演示。
