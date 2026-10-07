// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file api.ts
 * config/write 对外**纯 TS API**(2026-09-04 冻结区)。
 *
 * 冻结决策(用户拍板):一键配置的“内容语义/高级分析”(cpp 依赖、py 意图、msg 类型归属等)
 * 判定为不再扩展——本模块定位为“执行引擎”存量资产,以只读 API 形式向外暴露,供未来消费,
 * 不再做一键语义优化。契约:
 *  - 纯 TS、零 vscode 依赖、可无头调用;
 *  - 幂等/追加/规范形态/标注语义保持现状(修复缺陷仍会维护,不改行为面);
 *  - 编排层(vscode)仍在 ./index.ts(configure-file/package-rename),本 API 不导出它们。
 */

// —— 01 一键配置:纯计划层(角色识别 + 追加/改写计划 + 幂等) ——
export {
    planConfigure,
    detectRole,
    stampTimestamp,
    stampComment,
    stampSnippet,
} from "./configure-actions";
export type {
    ConfigurePlan,
    PlannedWrite,
    ConfigurePackage,
    ConsoleScriptTarget,
    BuildTypeName,
    Role,
    BuildTexts,
    StampFile,
} from "./configure-actions";

// —— 02 重命名:纯动作层 ——
export {
    validatePackageName,
    planRenameByFolder,
} from "./rename-actions";
export type {
    RenameTargets,
    RenamePlan,
    RenamePlanFile,
} from "./rename-actions";

// —— 定位/改写原语(anchors 桶,冻结) ——
export * as anchors from "./anchors";
