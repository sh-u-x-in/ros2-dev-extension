// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file generated-file.ts
 * 生成文件模型(create 子域,2026-09-04 结构重构建立)。
 *
 * GeneratedFile 的唯一定义(消除 create-cpp-package / create-python-package 各自
 * 一份接口的重复; 差异仅是 cpp 版带 directory、py 版不带——统一为可选字段, 语义无损)。
 * 纯类型 + 常量, 无运行逻辑。
 */

/** 生成的一个文件(路径相对包目录) */
export interface GeneratedFile {
    path: string;
    content: string;
    /** true 表示仅创建空目录(不写内容); false/缺省 = 普通文件 */
    directory?: boolean;
    /**
     * true = 写盘后需可执行位(仅 install(PROGRAMS) 安装的 Python 脚本)。
     * 依据: 符号链接安装下 PROGRAMS 文件软链回源, 源无 +x 会被 ros2 的 X_OK 过滤静默漏掉。
     */
    exec?: boolean;
}
