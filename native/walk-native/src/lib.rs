//! walk-native 原生库入口(napi-rs)
//!
//! 暴露 `walkWithTimeout` 给 Node / VS Code 扩展(扩展侧集成点:src/build-tool/walk/walk-utils.ts)。
//! CLI 入口在 main.rs(bin crate),复用同一 lib 逻辑。
//!
//! 默认使用节点级动态队列并行(walk_parallel_branch, worker 数 = CPU 核数),
//! 该实现是 2026-08-20 实测最优模型(相对 TS ~5.6×, 且防重入/负载均衡/无层间同步)。

pub mod model;
pub mod walker;

use std::path::Path;

#[macro_use]
extern crate napi_derive;

use regex::Regex;

use model::{Matcher, WalkOptions};
use walker::walk_parallel_branch;

/// 遍历配置(与 TS 版 WalkOptions 对齐)
#[napi(object)]
pub struct WalkOptionsJs {
    /// 分支时长限制(毫秒):单目录处理上限,超时截断该分支
    pub branch_timeout_ms: u32,
    /// 总超时时长(毫秒):整个搜索上限,超时整体结束
    pub total_timeout_ms: u32,
    /// 最大递归深度
    pub max_depth: u32,
    /// 按目录名提前排除
    pub excluded_dir_names: Option<Vec<String>>,
    /// 是否跟随符号链接目录
    pub follow_symlinks: bool,
}

/// 遍历结果(与 TS 版 WalkResult 对齐)
#[napi(object)]
pub struct WalkResultJs {
    pub matches: Vec<String>,
    pub timed_out: bool,
    pub elapsed_ms: u32,
    pub visited_dirs: u32,
    pub loop_skipped: u32,
}

/// 节点级动态队列并行遍历(worker 数 = CPU 核数)。
/// pattern_type: "exact"(精确文件名) | "regex"(正则);pattern: 对应模式内容。
#[napi]
pub fn walk_with_timeout(
    root: String,
    pattern_type: String,
    pattern: String,
    opts: WalkOptionsJs,
) -> WalkResultJs {
    let matcher = if pattern_type == "regex" {
        Regex::new(&pattern)
            .map(Matcher::Regex)
            .unwrap_or_else(|_| Matcher::Exact(pattern))
    } else {
        Matcher::Exact(pattern)
    };
    let wopts = WalkOptions {
        branch_timeout_ms: opts.branch_timeout_ms as u64,
        total_timeout_ms: opts.total_timeout_ms as u64,
        max_depth: opts.max_depth as usize,
        excluded_dir_names: opts.excluded_dir_names,
        follow_symlinks: opts.follow_symlinks,
    };
    let workers = std::thread::available_parallelism().map(|v| v.get()).unwrap_or(4);
    let r = walk_parallel_branch(Path::new(&root), &matcher, &wopts, workers);
    WalkResultJs {
        matches: r.matches,
        timed_out: r.timed_out,
        elapsed_ms: r.elapsed_ms as u32,
        visited_dirs: r.visited_dirs as u32,
        loop_skipped: r.loop_skipped as u32,
    }
}
