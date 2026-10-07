// (c) MIT

/**
 * @file types.ts
 * anchors/ 通用跨度类型(定位层的产物形状)。
 */

/** 半开区间 [start, end),指向源文本的一个区间 */
export interface Span {
    start: number;
    end: number;
}

/** 开括号索引 + 配对闭括号索引(两者都指向括号字符本身) */
export interface BracketPair {
    openIndex: number;
    closeIndex: number;
}
