/**
 * rosmsg 语义 token 数据生成(纯函数,不依赖 VS Code API,可单测)
 *
 * token 类型索引:
 *  0 = namespace(包名), 1 = type(消息名/内置类型), 2 = variable(字段名/常量名)
 *
 * 编码(SemanticTokens 标准):每 5 个数一个 token
 *  [deltaLine, deltaStartChar, length, tokenTypeIndex, modifiers]
 *  - deltaLine > 0 时 deltaStartChar 为相对行首列;== 0 时相对上一 token 结束列
 */

import { RosMsgDocument } from "./rosmsg-document";

/**
 * 生成语义 token 数据(纯函数)
 * @param doc 结构模型
 * @returns SemanticTokens 编码数组(每 5 个元素一个 token)
 */
export function buildSemanticTokenData(doc: RosMsgDocument): number[] {
    const data: number[] = [];
    let prevLine = 0;
    let prevChar = 0;

    const push = (line: number, char: number, length: number, typeIdx: number) => {
        const deltaLine = line - prevLine;
        const deltaChar = deltaLine === 0 ? char - prevChar : char;
        data.push(deltaLine, deltaChar, length, typeIdx, 0);
        prevLine = line;
        prevChar = char + length;
    };

    for (const section of doc.sections) {
        for (const f of section.fields) {
            const base = f.type.base;
            const slash = base.indexOf("/");
            if (slash > 0) {
                // 包名 → namespace
                push(f.line, f.typeColumn, slash, 0);
                // 消息名 → type
                push(f.line, f.typeColumn + slash + 1, base.length - slash - 1, 1);
            } else {
                // 未限定类型 / 内置类型 → type
                push(f.line, f.typeColumn, base.length, 1);
            }
            // 字段名 / 常量名 → variable
            push(f.line, f.nameColumn, f.name.length, 2);
        }
    }

    return data;
}
