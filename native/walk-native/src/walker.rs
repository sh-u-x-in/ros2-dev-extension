//! 三档遍历实现
//!
//! 双超时语义(2026-08-20 用户定稿,精确对齐 ts-walk.ts):
//!  - branchTimeoutMs(分支时长限制):单目录(分支)的【子树累积窗口】——该目录开始处理起,
//!    累计其文件循环 + 所有后代递归的处理时长,超过预算 → 截断该目录剩余(父层继续兄弟)。
//!    实现:子节点继承父节点开始时刻(parent_branch_start),处理前检查
//!    `now - parent_branch_start > budget` 即父窗口超时(子树累积),变相限制深度/扇出;
//!  - totalTimeoutMs(总超时时长):整个搜索时长上限,超时整体结束,返回已搜到的部分结果;
//!  - 优先级:总超时优先于分支超时(总超时置整体停止标志)。
//!
//! 三档:
//!  - walk_single:          单线程显式迭代栈 DFS(与 ts-walk.ts 语义最贴近);
//!  - walk_parallel:        分层并行(BFS 层级扇出 + rayon);
//!  - walk_parallel_branch: 节点级动态队列(默认,worker=CPU核):每目录=节点,
//!                          worker 取节点处理完把子目录入队;防重入;分支超时只截断该节点。

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use rayon::prelude::*;

use crate::model::{Matcher, WalkOptions, WalkResult};

/// 任务节点:(目录, 深度, 父分支开始时刻)。父分支开始时刻用于子树累积窗口检查。
type Node = (PathBuf, usize, Option<Instant>);

/// 单目录处理结果:区分分支超时与总超时(总超时需要整体停止传播)
enum DirOutcome {
    /// 正常完成(匹配增量, 子目录节点列表, 子节点继承本目录开始时刻)
    Done(Vec<String>, Vec<Node>),
    /// 分支超时:截断该分支(放弃本目录剩余),父层继续兄弟
    BranchTimeout,
    /// 总超时:整体结束(放弃本目录, 且整体不再继续)
    TotalTimeout,
}

fn to_excluded(opts: &WalkOptions) -> Option<HashSet<String>> {
    opts.excluded_dir_names.as_ref().map(|v| v.iter().cloned().collect())
}

/// 父分支窗口超时检查:now - parent_start > branchTimeoutMs(子树累积,变相限深度)
fn parent_window_overdue(now: Instant, parent_start: Option<Instant>, budget_ms: u64) -> bool {
    match parent_start {
        Some(ps) => now.duration_since(ps).as_millis() as u64 > budget_ms,
        None => false, // 根节点无父窗口
    }
}

/// 环检测(仅 followSymlinks 时启用):canonicalize 后查全局 visited 集合,
/// 重复则跳过 → 防符号链接环 / junction 环 / 同一物理目录多路径重复遍历。
fn should_skip_loop(dir: &Path, visited: &Mutex<HashSet<PathBuf>>) -> bool {
    let canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    !visited.lock().unwrap().insert(canon)
}

/// 并行遍历看门狗宽限(毫秒):超过 totalTimeoutMs + 宽限仍未完成 → 视为死锁/无限循环,报错退出
const WATCHDOG_GRACE_MS: u64 = 1000;

/// 目录条目类型判断:符号链接目录在 follow 时跟随解析
fn entry_is_dir(entry: &fs::DirEntry, ft: &fs::FileType, follow_symlinks: bool) -> bool {
    if ft.is_dir() {
        return true;
    }
    if follow_symlinks && ft.is_symlink() {
        return fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false);
    }
    false
}

/// 处理单个目录(一个分支/节点):读条目 → 匹配文件收集 → 收集子目录。
/// 双超时:总超时优先(globalDeadline);分支超时 = 本目录自身窗口(own_start 起算,
/// 单目录条目过多/处理过慢时截断)。父窗口(子树累积)由调用方在进入前检查。
fn process_dir(
    dir: &Path,
    depth: usize,
    matcher: &Matcher,
    opts: &WalkOptions,
    excluded: &Option<HashSet<String>>,
    global_deadline: Instant,
    own_start: Instant,
) -> DirOutcome {
    if depth > opts.max_depth {
        return DirOutcome::Done(Vec::new(), Vec::new());
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return DirOutcome::Done(Vec::new(), Vec::new()), // 不可访问:跳过
    };
    let mut local_matches = Vec::new();
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let now = Instant::now();
        // 总超时优先:全局截止 → 整体结束
        if now > global_deadline {
            return DirOutcome::TotalTimeout;
        }
        // 分支超时:本目录自身处理超过分支时长限制 → 截断该目录
        if now.duration_since(own_start).as_millis() as u64 > opts.branch_timeout_ms {
            return DirOutcome::BranchTimeout;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if ft.is_file() {
            if matcher.matches(&name_str) {
                local_matches.push(entry.path().to_string_lossy().into_owned());
            }
        } else if entry_is_dir(&entry, &ft, opts.follow_symlinks) {
            if let Some(ex) = excluded {
                if ex.contains(name_str.as_ref()) {
                    continue; // 目录名排除
                }
            }
            // 子节点继承本目录开始时刻(父窗口,子树累积计时)
            subdirs.push((entry.path(), depth + 1, Some(own_start)));
        }
    }
    DirOutcome::Done(local_matches, subdirs)
}

/// 单线程:显式迭代栈 DFS + 双超时(分支子树窗口截断/总结束),语义与 ts-walk.ts 对齐
pub fn walk_single(root: &Path, matcher: &Matcher, opts: &WalkOptions) -> WalkResult {
    let start = Instant::now();
    let global_deadline = start + Duration::from_millis(opts.total_timeout_ms);
    let excluded = to_excluded(opts);
    let loop_visited = Mutex::new(HashSet::new());

    let mut stack: Vec<Node> = vec![(root.to_path_buf(), 0, None)];
    let mut matches = Vec::new();
    let mut visited_dirs = 0usize;
    let mut loop_skipped = 0usize;
    let mut timed_out = false;

    while let Some((dir, depth, parent_bs)) = stack.pop() {
        // 总超时:整体结束(不再取任何节点,避免空转)
        if Instant::now() > global_deadline {
            timed_out = true;
            break;
        }
        // 父窗口检查(子树累积超时):不进入不计数,跳过(等价 ts-walk 父层截断剩余兄弟)
        if parent_window_overdue(Instant::now(), parent_bs, opts.branch_timeout_ms) {
            timed_out = true;
            continue;
        }
        if depth > opts.max_depth {
            continue; // 超限深度:不深入也不计数(对齐 ts-walk visitedDirs 语义)
        }
        // 环检测(仅 followSymlinks):同一物理目录只遍历一次,防符号链接/junction 环
        if opts.follow_symlinks && should_skip_loop(&dir, &loop_visited) {
            loop_skipped += 1;
            continue;
        }
        visited_dirs += 1;
        // 本目录自身窗口开始时刻
        let own_start = Instant::now();
        match process_dir(&dir, depth, matcher, opts, &excluded, global_deadline, own_start) {
            DirOutcome::Done(m, subdirs) => {
                matches.extend(m);
                // DFS 顺序:子目录按出现顺序处理 → LIFO 栈需反转
                for sd in subdirs.into_iter().rev() {
                    stack.push(sd);
                }
            }
            DirOutcome::BranchTimeout => {
                // 分支超时:截断该目录(剩余文件/子目录放弃),父层继续兄弟
                timed_out = true;
            }
            DirOutcome::TotalTimeout => {
                // 总超时:整体结束,不空转
                timed_out = true;
                break;
            }
        }
    }

    WalkResult {
        matches,
        timed_out,
        elapsed_ms: start.elapsed().as_millis() as u64,
        visited_dirs,
        loop_skipped,
    }
}

/// 并行(分层 BFS):每层所有目录并行处理,收集子目录为下一层。并行度 = 每层目录数;
/// 层间同步点较多(每层 collect 后才进下一层),窄层并行度浪费。
pub fn walk_parallel(root: &Path, matcher: &Matcher, opts: &WalkOptions) -> WalkResult {
    let start = Instant::now();
    let global_deadline = start + Duration::from_millis(opts.total_timeout_ms);
    let excluded = to_excluded(opts);
    // 停止标志(总超时):整体停;any_timeout(报告):分支或总超时都算"发生过截断"
    let stopped = Arc::new(AtomicBool::new(false));
    let any_timeout = Arc::new(AtomicBool::new(false));
    let visited = Arc::new(AtomicUsize::new(0));
    let loop_skipped = Arc::new(AtomicUsize::new(0));
    let loop_visited = Mutex::new(HashSet::new());
    let matches = Arc::new(Mutex::new(Vec::<String>::new()));

    let mut current: Vec<Node> = vec![(root.to_path_buf(), 0, None)];
    while !current.is_empty() && !stopped.load(Ordering::Relaxed) {
        // 层间检查总超时
        if Instant::now() > global_deadline {
            stopped.store(true, Ordering::Relaxed);
            any_timeout.store(true, Ordering::Relaxed);
            break;
        }
        let next: Vec<Node> = current
            .par_iter()
            .filter_map(|(dir, depth, parent_bs)| {
                if stopped.load(Ordering::Relaxed) {
                    return None;
                }
                // 父窗口检查(子树累积):该目录不进入不计数
                if parent_window_overdue(Instant::now(), *parent_bs, opts.branch_timeout_ms) {
                    any_timeout.store(true, Ordering::Relaxed);
                    return None;
                }
                if *depth > opts.max_depth {
                    return None;
                }
                // 环检测(仅 followSymlinks):同一物理目录只遍历一次
                if opts.follow_symlinks && should_skip_loop(dir, &loop_visited) {
                    loop_skipped.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
                visited.fetch_add(1, Ordering::Relaxed);
                // 本目录自身窗口开始时刻
                let own_start = Instant::now();
                match process_dir(dir, *depth, matcher, opts, &excluded, global_deadline, own_start) {
                    DirOutcome::Done(m, subdirs) => {
                        if !m.is_empty() {
                            matches.lock().unwrap().extend(m);
                        }
                        Some(subdirs)
                    }
                    DirOutcome::BranchTimeout => {
                        // 分支超时:截断该目录,其他并行目录不受影响
                        any_timeout.store(true, Ordering::Relaxed);
                        None
                    }
                    DirOutcome::TotalTimeout => {
                        // 总超时:整体停
                        stopped.store(true, Ordering::Relaxed);
                        any_timeout.store(true, Ordering::Relaxed);
                        None
                    }
                }
            })
            .flatten()
            .collect();
        current = next;
    }

    WalkResult {
        matches: Arc::try_unwrap(matches).ok().map(|m| m.into_inner().unwrap()).unwrap_or_default(),
        timed_out: any_timeout.load(Ordering::Relaxed),
        elapsed_ms: start.elapsed().as_millis() as u64,
        visited_dirs: visited.load(Ordering::Relaxed),
        loop_skipped: loop_skipped.load(Ordering::Relaxed),
    }
}

/// 并行(节点级动态队列):固定 num_workers 个 worker,共享一个任务队列。
/// 每个目录 = 一个节点;worker 取一个节点处理,把其子目录全部入队,再取下一个节点。
///  - 负载均衡:先完成的 worker 立即取下一个节点,不等待其他分支;
///  - 防重入:每个节点只被唯一父节点产生一次、只处理一次;
///  - 双超时:分支超时(父窗口子树累积/自身窗口)只截断该节点;总超时整体停。
pub fn walk_parallel_branch(
    root: &Path,
    matcher: &Matcher,
    opts: &WalkOptions,
    num_workers: usize,
) -> WalkResult {
    let start = Instant::now();
    let global_deadline = start + Duration::from_millis(opts.total_timeout_ms);
    let excluded = to_excluded(opts);
    // 停止标志(总超时):整体停;any_timeout(报告):分支或总超时都算
    let stopped = Arc::new(AtomicBool::new(false));
    let any_timeout = Arc::new(AtomicBool::new(false));
    let visited = Arc::new(AtomicUsize::new(0));
    let loop_skipped = Arc::new(AtomicUsize::new(0));
    let loop_visited = Mutex::new(HashSet::new());
    let matches = Arc::new(Mutex::new(Vec::<String>::new()));
    // 任务队列:待处理节点
    let queue: Arc<Mutex<VecDeque<Node>>> = Arc::new(Mutex::new(VecDeque::new()));
    let condvar = Arc::new(Condvar::new());
    // 未完成节点数(队列中 + 处理中);fetch_sub 旧值==1 且无新节点入队 → 全部完成
    let pending = Arc::new(AtomicUsize::new(1));
    let finished = Arc::new(AtomicBool::new(false));

    {
        let mut q = queue.lock().unwrap();
        q.push_back((root.to_path_buf(), 0, None));
    }

    // 看门狗:并行 worker 若因 pending 计数 bug / panic 等卡死(无限循环/死锁),
    // 超过 totalTimeoutMs+宽限仍未完成 → 报错退出(保证至少能退出并让用户知道有错)。
    // detach 不 join:遍历完成立即返回;watchdog 短间隔轮询 done,正常完成 ≤100ms 内自退,
    // 卡死则在 watchdog_timeout 后强制 exit(2)。
    let done = Arc::new(AtomicBool::new(false));
    let watchdog_timeout = opts.total_timeout_ms.saturating_add(WATCHDOG_GRACE_MS);
    if watchdog_timeout > 0 {
        let done = Arc::clone(&done);
        std::thread::spawn(move || {
            let mut waited_ms = 0u64;
            while waited_ms < watchdog_timeout {
                std::thread::sleep(Duration::from_millis(100));
                waited_ms += 100;
                if done.load(Ordering::Relaxed) {
                    return; // 遍历正常完成,看门狗退出
                }
            }
            eprintln!(
                "[walk-native] 错误: 遍历疑似死锁/无限循环,超过预算+{}ms 仍未完成,强制退出",
                WATCHDOG_GRACE_MS
            );
            std::process::exit(2);
        });
    }

    std::thread::scope(|s| {
        for _ in 0..num_workers.max(1) {
            s.spawn(|| {
                loop {
                    // 取节点;总超时/完成 → 退出
                    let node = {
                        let mut q = queue.lock().unwrap();
                        loop {
                            if stopped.load(Ordering::Relaxed) || Instant::now() > global_deadline {
                                stopped.store(true, Ordering::Relaxed);
                                any_timeout.store(true, Ordering::Relaxed);
                                q.clear();
                                finished.store(true, Ordering::Relaxed);
                                condvar.notify_all();
                                break None;
                            }
                            if let Some(t) = q.pop_front() {
                                break Some(t);
                            }
                            if finished.load(Ordering::Relaxed) {
                                break None;
                            }
                            // wait_timeout 而非 wait:即使通知丢失/pending 计数 bug,
                            // 也会周期性醒来重新检查超时/完成条件,防死锁
                            q = condvar.wait_timeout(q, Duration::from_millis(200)).unwrap().0;
                        }
                    };
                    let Some((dir, depth, parent_bs)) = node else { break };

                    if depth > opts.max_depth {
                        // 超限节点不计数不深入,只完成本节点
                        if pending.fetch_sub(1, Ordering::Relaxed) == 1 {
                            finished.store(true, Ordering::Relaxed);
                            condvar.notify_all();
                        } else {
                            condvar.notify_one();
                        }
                        continue;
                    }
                    // 父窗口检查(子树累积超时):该节点不进入不计数
                    if parent_window_overdue(Instant::now(), parent_bs, opts.branch_timeout_ms) {
                        any_timeout.store(true, Ordering::Relaxed);
                        if pending.fetch_sub(1, Ordering::Relaxed) == 1 {
                            finished.store(true, Ordering::Relaxed);
                            condvar.notify_all();
                        } else {
                            condvar.notify_one();
                        }
                        continue;
                    }
                    // 环检测(仅 followSymlinks):同一物理目录只遍历一次,防符号链接/junction 环
                    if opts.follow_symlinks && should_skip_loop(&dir, &loop_visited) {
                        loop_skipped.fetch_add(1, Ordering::Relaxed);
                        if pending.fetch_sub(1, Ordering::Relaxed) == 1 {
                            finished.store(true, Ordering::Relaxed);
                            condvar.notify_all();
                        } else {
                            condvar.notify_one();
                        }
                        continue;
                    }
                    visited.fetch_add(1, Ordering::Relaxed);
                    // 本目录自身窗口开始时刻
                    let own_start = Instant::now();

                    match process_dir(&dir, depth, matcher, opts, &excluded, global_deadline, own_start) {
                        DirOutcome::Done(m, subdirs) => {
                            if !m.is_empty() {
                                matches.lock().unwrap().extend(m);
                            }
                            let n = subdirs.len();
                            {
                                let mut q = queue.lock().unwrap();
                                pending.fetch_add(n, Ordering::Relaxed); // 先入队计数
                                q.extend(subdirs);
                            }
                            // 本节点完成;旧值==1 且无新节点 → 全部完成
                            if pending.fetch_sub(1, Ordering::Relaxed) == 1 {
                                finished.store(true, Ordering::Relaxed);
                                condvar.notify_all();
                            } else {
                                condvar.notify_one();
                            }
                        }
                        DirOutcome::BranchTimeout => {
                            // 分支超时:截断该节点(子目录不入队),worker 继续取下一个节点
                            any_timeout.store(true, Ordering::Relaxed);
                            if pending.fetch_sub(1, Ordering::Relaxed) == 1 {
                                finished.store(true, Ordering::Relaxed);
                                condvar.notify_all();
                            } else {
                                condvar.notify_one();
                            }
                        }
                        DirOutcome::TotalTimeout => {
                            // 总超时:整体停(其余 worker 检查 stopped 退出)
                            stopped.store(true, Ordering::Relaxed);
                            any_timeout.store(true, Ordering::Relaxed);
                            let mut q = queue.lock().unwrap();
                            q.clear();
                            finished.store(true, Ordering::Relaxed);
                            condvar.notify_all();
                        }
                    }
                }
            });
        }
    });

    // 遍历完成,通知看门狗退出(detach 线程,≤100ms 内自退;不 join,立即返回)
    done.store(true, Ordering::Relaxed);

    // 完成校验:worker 全部退出但未置 finished(仅 panic/异常路径可能) → 报错退出
    if !finished.load(Ordering::Relaxed) {
        eprintln!("[walk-native] 错误: 并行遍历异常终止(worker 未正常完成)");
        std::process::exit(2);
    }

    WalkResult {
        matches: Arc::try_unwrap(matches).ok().map(|m| m.into_inner().unwrap()).unwrap_or_default(),
        timed_out: any_timeout.load(Ordering::Relaxed),
        elapsed_ms: start.elapsed().as_millis() as u64,
        visited_dirs: visited.load(Ordering::Relaxed),
        loop_skipped: loop_skipped.load(Ordering::Relaxed),
    }
}
