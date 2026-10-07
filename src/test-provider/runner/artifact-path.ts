// Licensed under the MIT License.

/**
 * @file artifact-path.ts
 * 测试临时产物(junitxml / gtest xml)的**唯一路径生成**(2026-09-24 B7.1)。
 *
 * 为什么单独成文件:并行 Run All 时,同毫秒 + 同 pid 会让多个进程撞出**同名**产物路径
 * (真机实测:32 项并行批里 19 个 pytest 进程只分到 4 个路径),后果有两面 ——
 *   ① 先结束者 `removeArtifact` 删除共享路径 → 后结束者读不到,误报"未产生结果文件";
 *   ② 先结束者可能读到**别人的** XML → 结果串台(日志实证"用例 2 条,目标项 1 个");
 * 受害者"断言失败"会被降级成 errored、丢失断言消息(实测 test_main_runs_and_reports)。
 * 故文件名追加**进程内单调序号**,保证"一次执行一份产物"。
 */

import * as os from "os";
import * as path from "path";

/** 进程内单调序号:Date.now() 同毫秒 + pid 相同时唯一的区分依据 */
let seq = 0;

/** 生成一份新的测试产物路径(同一进程内每次调用必不相同) */
export function nextArtifactPath(kind: "pytest" | "gtest" | "launch", tmpDir: string = os.tmpdir()): string {
    seq += 1;
    return path.join(tmpDir, `ros2-ide-${kind}-${Date.now()}-${process.pid}-${seq}.xml`);
}
