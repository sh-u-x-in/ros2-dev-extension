// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file meta.ts
 * 模板共享元数据常量表(create/templates,2026-09-04 结构重构建立)。
 *
 * package.xml / setup.py / CMakeLists.txt 模板中重复出现的包元数据值收敛于此,
 * 作为"variable-substitution slot"的扩展位:后续调整(如版本、license、维护者信息、描述口径)
 * 只改本表, 各模板经 ${PKG_META.xxx} 引用, 输出逐字节不变(本表初值即原内联值)。
 */

/** 生成包元数据(与现模板内联值逐字一致, 勿改初值除非有意变更产物) */
export const PKG_META = {
    /** 版本号(所有包类型模板共用) */
    version: '0.0.0',
    /** 许可证(所有包类型模板共用) */
    license: 'Apache-2.0',
    /** 维护者名(占位, 待用户自填) */
    maintainerName: 'you',
    /** 维护者邮箱(占位, 待用户自填) */
    maintainerEmail: 'you@todo.todo',
} as const;

/** package.xml 声明行 + schema 模型行(两种包类型共用) */
export const XML_DECL_LINES: readonly string[] = [
    '<?xml version="1.0"?>',
    '<?xml-model href="http://download.ros.org/schema/package_format3.xsd" schematypens="http://www.w3.org/2001/XMLSchema"?>',
];
