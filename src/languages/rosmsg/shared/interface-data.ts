import { l10n } from 'vscode'; // 2026-10-04 i18n 期2

/**
 * ROS 接口的共享静态数据(内置类型 / 常用包)
 * 供 providers(hover/definition)与 completion-provider 共用,避免两套常量
 */

/** ROS 2 内置消息类型及其描述 */
export const BUILTIN_TYPES: { [key: string]: string } = {
    "bool": l10n.t("Boolean (true/false)"),
    "byte": l10n.t("8-bit unsigned integer (0-255); prefer uint8"),
    "char": l10n.t("8-bit signed integer (-128 to 127); prefer int8"),
    "int8": l10n.t("8-bit signed integer (-128 to 127)"),
    "uint8": l10n.t("8-bit unsigned integer (0-255)"),
    "int16": l10n.t("16-bit signed integer (-32,768 to 32,767)"),
    "uint16": l10n.t("16-bit unsigned integer (0-65,535)"),
    "int32": l10n.t("32-bit signed integer (-2,147,483,648 to 2,147,483,647)"),
    "uint32": l10n.t("32-bit unsigned integer (0-4,294,967,295)"),
    "int64": l10n.t("64-bit signed integer"),
    "uint64": l10n.t("64-bit unsigned integer"),
    "float32": l10n.t("32-bit floating point"),
    "float64": l10n.t("64-bit floating point (double precision)"),
    "string": l10n.t("UTF-8 encoded string"),
    "wstring": l10n.t("Wide string (UTF-16)"),
    "time": l10n.t("ROS time (seconds and nanoseconds)"),
    "duration": l10n.t("ROS duration (seconds and nanoseconds)")
};

/** 常用的 ROS 2 接口包及其描述 */
export const COMMON_PACKAGES: { [key: string]: string } = {
    "std_msgs": l10n.t("Standard ROS message types"),
    "geometry_msgs": l10n.t("Geometric primitive messages for common shapes"),
    "sensor_msgs": l10n.t("Sensor data messages"),
    "nav_msgs": l10n.t("Navigation messages"),
    "builtin_interfaces": l10n.t("ROS 2 built-in interface types (Time, Duration)"),
    "action_msgs": l10n.t("Action communication messages"),
    "diagnostic_msgs": l10n.t("Diagnostic messages for system health monitoring"),
    "trajectory_msgs": l10n.t("Trajectory representation messages"),
    "visualization_msgs": l10n.t("Visualization markers and displays")
};

/** 判断类型是否为 ROS 内置类型 */
export function isBuiltinType(type: string): boolean {
    return type in BUILTIN_TYPES;
}
