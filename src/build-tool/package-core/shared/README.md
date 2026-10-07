# shared/ — 共享工具(值类型 + 事件发射器)

package-core 内部跨层共享的零依赖工具(对外部不可见;外部一律经 api/)。

## 文件清单

| 文件 | 职责 |
|---|---|
| `types.ts` | 跨层值类型:PackageEntry(**来源权威 = PackageDataState 分域**:system 域=系统包;buildType 三态仅字段类型统一——具体值=工作区合法类型(cache 层合并)/ `""`=系统包 / undefined=未取到)+ 谓词 isPythonPackage + PYTHON_BUILD_TYPE 常量(仅工作区包类型判别,经 api 暴露);ExecutableInfo 已注释保留(随 getExecutables 链摘除) |
| `emitter.ts` | 通用事件发射器(2026-08-29 逻辑吸收提取):data/ 与 data/package-cache 共用,消除三份同构拷贝 |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-08-30 18:42 | 创建 shared/ README(文件清单) |
| 2026-09-02 11:03 | PackageEntry.buildType 三态约定(用户定稿):具体值=工作区包合法类型(cache 层从 walk 画像合并)、`""`=系统包(ros2 pkg list 不携带 build_type)、undefined=工作区包未取到(colcon list 快路径/扫描异常)——消费方可区分三态 |
| 2026-09-02 11:10 | 补充:buildType 来源修正——由 cache 层合并进 WorkspacePackage 后 data 继承(不跨层补),三态语义不变 |
| 2026-09-03 22:58 | 死代码复核同步(项目结尾):types.ts ExecutableInfo 注释(2026-08-29 摘除保留)补 2026-09-03 复核注——可执行派生已落地 package-service/config/exe-map(05 任务 6),本条仅供历史参考,维持注释保留;文件清单与当前代码核对一致;详见 package-core/README.md 墓碑登记 |