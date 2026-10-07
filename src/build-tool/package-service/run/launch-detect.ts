// Licensed under the MIT License.

/**
 * @file launch-detect.ts(2026-09-25 新增)
 * launch 文件识别与展示名(**纯函数,零 vscode**)。
 * 侧边栏(share 区 → launch 区提升)与运行数据源(`run-data-source.ts`)共用同一判定,
 * 保证"树上看见的"与"面板里能选的"永远是同一批文件。
 */

/** ROS 2 launch 官方前端识别的扩展名(launch 前端只注册 .py/.xml/.yaml;.yml 不认) */
const LAUNCH_EXTS = [".launch.py", ".launch.xml", ".launch.yaml"];

/** 是否为 launch 文件(按安装侧相对路径/文件名判定;大小写不敏感) */
export function isLaunchFileName(name: string): boolean {
    const lower = name.toLowerCase();
    return LAUNCH_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * 去 `launch/` 展示前缀(仅当确实以它开头):`launch/demo.launch.py` → `demo.launch.py`;
 * 更深的嵌套(`launch/nested/foo.launch.py`)只去第一层 → `nested/foo.launch.py`。
 * 去掉前缀后的名字恰好就是 `ros2 launch <pkg> <file>` 的 file 口径(相对 share/<pkg> 的路径)。
 */
export function trimLaunchDisplayPrefix(name: string): string {
    return name.startsWith("launch/") ? name.slice("launch/".length) : name;
}
