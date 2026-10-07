//! 数据模型:匹配器 / 遍历选项 / 遍历结果
//! 与 src/build-tool/walk/walk-utils.ts 的 FilePattern / WalkOptions / WalkResult 对齐(2026-08-20)

use regex::Regex;

/// 文件匹配模式:精确文件名 | 正则
/// 声明式 pattern,匹配在遍历器内部完成(无逐文件回调),便于底层直接内联
#[derive(Clone)]
pub enum Matcher {
    Exact(String),
    Regex(Regex),
}

impl Matcher {
    pub fn matches(&self, name: &str) -> bool {
        match self {
            Matcher::Exact(s) => name == s,
            Matcher::Regex(re) => re.is_match(name),
        }
    }
}

/// 遍历配置(与 TS 版 WalkOptions 对齐)
#[derive(Clone)]
pub struct WalkOptions {
    /// 分支时长限制(毫秒):单个目录(分支)处理时长上限,超时截断该分支,父层继续兄弟
    pub branch_timeout_ms: u64,
    /// 总超时时长(毫秒):整个搜索时长上限,超时整体结束,返回已搜到的部分结果
    pub total_timeout_ms: u64,
    /// 最大递归深度(0 = 只扫描根目录下的文件,不进入任何子目录)
    pub max_depth: usize,
    /// 按目录名提前排除(如 build/install/log),只匹配当前层条目名
    pub excluded_dir_names: Option<Vec<String>>,
    /// 是否跟随符号链接目录(默认 false,防共享目录遍历爆炸)
    pub follow_symlinks: bool,
}

/// 遍历结果(与 TS 版 WalkResult 对齐)
#[derive(Debug)]
pub struct WalkResult {
    /// 匹配的文件绝对路径(超时截断后为"已搜到的部分结果")
    pub matches: Vec<String>,
    /// 是否发生过超时截断
    pub timed_out: bool,
    /// 实际耗时(毫秒)
    pub elapsed_ms: u64,
    /// 访问过的目录数
    pub visited_dirs: usize,
    /// 环检测跳过的目录数(followSymlinks 时防符号链接/junction 环与重复遍历)
    pub loop_skipped: usize,
}
