//! walk-native:walk-utils.ts 底层重写原型(Rust) — CLI 入口(薄层)
//!
//! 语义对齐 src/build-tool/walk/walk-utils.ts(2026-08-20 用户定稿):
//!  - DFS;全局 deadline = start + timeLimitMs,时间叠加;
//!  - 分支级超时截断:某目录处理中超时 → 放弃该目录剩余文件与子目录,回溯父层继续兄弟;
//!  - 深度限制(maxDepth) + 时间限制(timeLimitMs) 双限制;
//!  - 目录名排除(excludedDirNames)遍历时提前跳过;
//!  - 符号链接默认不跟随(followSymlinks=false);
//!  - 超时返回已搜到的部分结果(timedOut=true)。
//!
//! 模块划分:
//!  - model.rs  类型(Matcher / WalkOptions / WalkResult)
//!  - walker.rs 三档遍历实现(walk_single / walk_parallel / walk_parallel_branch)
//!  - main.rs   参数解析 + 分发 + 输出
//!
//! 用法:
//!   walk-native <root> <pattern> <maxDepth> [--branch-timeout <ms>] [--total-timeout <ms>]
//!               [--regex] [--exclude a,b,c] [--follow-symlinks] [--parallel | --branch]
//!               [--workers N] [--json]
//!   (未指定时:--total-timeout 默认 5000ms;--branch-timeout 默认 = total-timeout)
//!   输出(默认): <标签> | branch=XXXXms total=XXXXms depth=NN | matches=NN timedOut=xxx elapsed=NNNNms visitedDirs=NNNNN

use std::env;
use std::path::PathBuf;

use regex::Regex;

use walk_native_core::model::{Matcher, WalkOptions};
use walk_native_core::walker::{walk_parallel, walk_parallel_branch, walk_single};

/// 环跳过阈值:超过则视为异常目录结构(如海量符号链接环),报错退出
const LOOP_SKIP_LIMIT: usize = 1000;

fn usage() -> ! {
    eprintln!(
        "用法: walk-native <root> <pattern> <maxDepth> [选项]\n\
         选项:\n\
           --branch-timeout N  分支时长限制 ms(单目录处理上限,默认=total)\n\
           --total-timeout N   总超时时长 ms(整个搜索上限,默认 5000)\n\
           --regex              pattern 按正则匹配(默认精确文件名)\n\
           --exclude a,b,c     排除的目录名(逗号分隔)\n\
           --follow-symlinks   跟随符号链接目录(默认不跟随)\n\
           --parallel          并行:分层 BFS(rayon 默认线程池)\n\
           --branch            并行:节点级动态队列(每 worker 取一个目录节点,子目录入队)\n\
           --workers N         节点级并行 worker 数(默认 CPU 核数;如 4/6/8)\n\
           --json              输出 JSON"
    );
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() < 3 {
        usage();
    }
    let root = PathBuf::from(&args[0]);
    let pattern = args[1].clone();
    let max_depth: usize = args[2].parse().unwrap_or_else(|_| usage());

    let mut branch_timeout_ms: Option<u64> = None;
    let mut total_timeout_ms: Option<u64> = None;
    let mut is_regex = false;
    let mut exclude: Option<Vec<String>> = None;
    let mut follow_symlinks = false;
    let mut mode = "single"; // single | layer | branch
    let mut workers: Option<usize> = None;
    let mut as_json = false;

    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--regex" => is_regex = true,
            "--exclude" => {
                i += 1;
                exclude = Some(
                    args[i]
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect(),
                );
            }
            "--branch-timeout" => {
                i += 1;
                branch_timeout_ms = Some(args[i].parse().unwrap_or_else(|_| usage()));
            }
            "--total-timeout" => {
                i += 1;
                total_timeout_ms = Some(args[i].parse().unwrap_or_else(|_| usage()));
            }
            "--follow-symlinks" => follow_symlinks = true,
            "--parallel" => mode = "layer",
            "--branch" => mode = "branch",
            "--workers" => {
                i += 1;
                workers = Some(args[i].parse().unwrap_or_else(|_| usage()));
            }
            "--json" => as_json = true,
            _ => usage(),
        }
        i += 1;
    }

    let matcher = if is_regex {
        Matcher::Regex(Regex::new(&pattern).unwrap_or_else(|e| {
            eprintln!("正则无效: {e}");
            std::process::exit(2);
        }))
    } else {
        Matcher::Exact(pattern)
    };
    // 双超时:total 默认 5000ms;branch 默认 = total(分支不额外收紧)
    let total = total_timeout_ms.unwrap_or(5000);
    let branch = branch_timeout_ms.unwrap_or(total);
    let opts = WalkOptions {
        branch_timeout_ms: branch,
        total_timeout_ms: total,
        max_depth,
        excluded_dir_names: exclude,
        follow_symlinks,
    };

    let (result, tag) = match mode {
        "single" => (walk_single(&root, &matcher, &opts), "[单线程]".to_string()),
        "layer" => (walk_parallel(&root, &matcher, &opts), "[分层]".to_string()),
        "branch" => {
            let n = workers
                .unwrap_or_else(|| std::thread::available_parallelism().map(|v| v.get()).unwrap_or(4));
            (walk_parallel_branch(&root, &matcher, &opts, n), format!("[节点x{n}]"))
        }
        _ => usage(),
    };

    // 环跳过异常多 → 目录结构疑似异常(海量符号链接/junction 环),报错退出
    if result.loop_skipped > LOOP_SKIP_LIMIT {
        eprintln!(
            "[walk-native] 错误: 环检测跳过 {} 个目录(超过阈值 {}),疑似异常目录结构",
            result.loop_skipped, LOOP_SKIP_LIMIT
        );
        std::process::exit(2);
    }

    if as_json {
        println!(
            "{{\"matches\":[{}],\"timedOut\":{},\"elapsedMs\":{},\"visitedDirs\":{},\"loopSkipped\":{}}}",
            result
                .matches
                .iter()
                .map(|m| format!("\"{}\"", m.replace('\\', "\\\\").replace('"', "\\\"")))
                .collect::<Vec<_>>()
                .join(","),
            result.timed_out,
            result.elapsed_ms,
            result.visited_dirs,
            result.loop_skipped
        );
    } else {
        let ex_tag = if opts.excluded_dir_names.is_some() { "排除产物" } else { "不排除  " };
        println!(
            "{} {} | branch={:5}ms total={:5}ms depth={:2} | matches={:3} timedOut={:5} elapsed={:5}ms visitedDirs={:6} loops={}",
            tag,
            ex_tag,
            branch,
            total,
            max_depth,
            result.matches.len(),
            result.timed_out,
            result.elapsed_ms,
            result.visited_dirs,
            result.loop_skipped
        );
    }
}
