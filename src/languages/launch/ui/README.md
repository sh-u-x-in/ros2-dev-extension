# src/languages/launch/ui/ — launch vscode 提供器(补全·跳转·悬浮·链接)

> launch 模块 2026-09-30 分层(LD-6.5)自 src/languages/launch/ 平铺迁入(git mv,历史不变)。
> 注册入口在模块根 providers.ts(留根,extension.ts 唯一触点)。

## 定位

vscode 语言提供器适配层:三格式(.launch.py / .launch|.launch.xml / .launch.yaml|.launch.yml)的
补全、解析跳转(F12)、include 链接(DocumentLink)与悬浮。候选与上下文判定下沉 core/,
launch.py 文本解析下沉 parse/;本层只做 Candidate→CompletionItem、范围锚定与注册。

## 文件

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| launch-completion.ts | 730 | 三格式 CompletionItemProvider + registerLaunchCompletionProviders(触发字符 py `' "`/xml `< ' " ( //yaml `' " : - (`;LC-9 窄门控);LC-4 include 路径单层(includeFileCandidates,**LD-2 不设 range**——VS Code 默认词边界,`$(find-pkg-share pkg)/` 前缀永不被抹);LC-5 跨文件传参名(uri+mtime 缓存);InstallTruthExecSource(LA-2,共享 BuildMapCenter);**LD-2 词锚 range**(subst-cmd 锚已敲前缀/arg-ref 锚已敲词);LD-6 pkg 候选 detail=工作区包 · 目录、exec detail=可执行名 · 包 |
| launch-definition-provider.ts | 232 | 解析跳转(LA-3/LD-3):XML node pkg/exec→包目录(package.xml 优先)/install-truth 源、include file→目标;py Node 值位/include;**yaml pkg:/exec:/file: 三值位(LD-3 补齐,值位判定复用补全同一 yamlCursorAt)**;文件级语义:落点一律 文件+line 0;LA-1 域门控 |
| launch-hover-provider.ts | 248 | 三格式悬浮(LD-5):包落点/exec 源/include 目标/$(var N) 声明行+默认值(LC-1 declLineText 首消费方)/kwarg·属性·yaml 键目录 detail;与链接/跳转同一条解析链路,命中才显示 |
| launch-link-provider.ts | 147 | XML include 链接(LaunchLinkProvider)+ **resolveLaunchIncludePath 共享解析导出**(find-pkg-share 经 PackageMap.resolvePackageDir 懒取,其余经 resolveFileRef,existsSync 门);**LD-3 selector 去 language:'xml' 双条件改纯 pattern**(.launch 裸后缀默认无 xml 语言,双条件下链接永不出现) |
| launchpy-provider.ts | 82 | .launch.py DocumentLink + Hover(include 目标;**LD-4 起 range=末段字面量引号内内容**——os.path.join/变量段让位 python 自身跳转);解析不成功静默 |
| yaml-link-provider.ts | 124 | YAML include 链接(`- include:` 块内 file: 值 → 复用 resolveLaunchIncludePath;selector 纯 pattern) |

## 依赖与接线

- 入边:模块根 providers.ts 统一注册(registerLaunchProviders(xacroPackages),extension.ts 唯一触点);
  test/suite/launch-completion-integration.test.ts、launch-exec-navigation.test.ts 直调各 provider;
- 出边:../core/*(候选/上下文/声明)、../parse/launch-py-parser(解析)、languages/shared/{package-map, workspace-domain}、
  install-truth/{api, center/shared-center}、vscode-utils(followSymlinks)、logger;
- 规则:LA-1 域门控(工作区根外一律早退)适用于本层全部提供器;补全项范围锚定一律"词锚"(不锚值起点,LD-2 铁律)。

## 修改记录

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-30 02:15 | 目录化建档(LD-6.5):六 provider 自 src/languages/launch/ 迁入(git mv;相对 import 上移);本目录在本次 LD 批次的其余增量——LD-2 词锚 range(LC-4 不设 range)、LD-3 yaml F12 + selector 纯 pattern、LD-5 launch-hover-provider 新建、LD-6 pkg/exec detail——见各行与模块根 README 修改记录 |
| 2026-09-27 21:30 | (迁入前,原模块根)LC 批次适配层总装(词锚偏差即自本批引入,LD-2 修复),见模块根 README 修改记录 |
