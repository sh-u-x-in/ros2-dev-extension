// (c) MIT

/**
 * @file index.ts
 * anchors/:文本定位与偏移测量层,供 config/write 上层(01 configure / 02 rename)做安全的结构改写。
 * 纯 TS,零 vscode 依赖。定位先行决策见 config/write/README.md。
 */

export * from "./types";
export * from "./scanner";
export * from "./python";
export * from "./cmake";
export * from "./xml";
