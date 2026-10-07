# anchors/ — 文本定位与偏移测量层(write 侧地基)

> 决策(2026-09-03):实现上层 configure/rename 之前,先建**精确位置**原语——
> setup.py / CMakeLists / package.xml 的插入常在跨行括号、或位于字符串/注释内的括号上出错
> (例:package.xml 依赖被追加到 `</package>` 之后 = XML 非法)。纯 TS,零 vscode 依赖,可无头测。
> 职责边界:**只回答「往哪插、插成什么形状/偏移」**;语义提取/幂等判定归 exe-map/parse;
> 生成/编排归 configure-actions/configure-file。
> 上层统一经 **桶出口 `index.ts`(`export *`)** 消费,不直连子模块(2026-09-04 规范化)。

## 文件清单与接口

| 文件 | 职责 | 主要接口 |
|---|---|---|
| types.ts | 通用跨度类型 | `Span[start,end)` / `BracketPair{openIndex,closeIndex}` |
| scanner.ts | 跨语言区域/括号 | `classifyRegions(text,lang)→code/str/comment`;`findMatchingClose`(嵌套/跨行/跳过字符串·注释·bracket 参数);`findCallOpen`;`regionAt`;`Lang/Region/RegionType` |
| python.ts | setup.py / Python 容器定位 | `findSetupCall` / `findCallParens`;`topLevelArgRanges` / `findKwargSpan`(setup() 内按顶层逗号切 kwarg 块,跨行·字符串·嵌套安全);`insertItemAtContainerTail`(list/dict/调用参数容器尾插,逗号语义正确);**`insertListItemCanonical`**(规范多行尾插:条目自带尾逗号+可选行尾标注,前一行已规范则零改写 → 纯行追加,可反复);**`findConsoleScriptsList`**(定位任意 entry_points 字典——内联 kwarg 或模块级变量赋值形态——的 console_scripts 列表);**`consoleListHasItem`**(列表内条目规范化去重);`insertBefore`;`lineIndentAt` |
| cmake.ts | CMake 定位/增量追加 | `findCommandParens` / `findAmentPackage` / `insertSnippetCmake`;行辅助 `indexLines`/`lineIndexOf`/`isCommentOnlyLine`/`commentTextOfLine`/`commentRuns`;`scanActiveCalls`(活跃命令,注释模板天然排除);`locateCmakeInsert`(增量三级定位 L1 活跃尾 / L2 注释模板上 / L3 ament_package 前·文件尾;kind=deps/interfaces/build/pyinstall/install);**`findActiveCallByArgs`**(命令+参数 hint 找活跃调用);**`locateCmakeTemplateCodeAnchor`**(create 模板区「首条被注释代码行」;`##` 说明头不参与匹配、不在其上方生成);**`cmakeAppendArgToBlock`**(块内追加:紧凑块先重排为**垂直规范形态**——命令头行上界 / 一参一行 / DESTINATION·DEPENDENCIES 区尾行 / 行尾 `)` 独立行——再在内容区尾部插新行;旧行标注保留、仅新增行带标注;幂等按块内含;返回 converted/already/reason) |
| xml.ts | package.xml(外包 @lezer/xml) | `XML_DEP_KINDS`(8 类依赖);`locateXmlDepInsert`(同类尾 / 依赖区尾 / export 前行首兜底);`insertXmlDepElement(text,kind,name,indent?,inlineComment?)`——第 4 参为**元素行尾内联标注**;`insertBeforePackageClose`;`nameTagSpan`;`findPackageCloseTag`;`depElementLine` |
| index.ts | 桶出口 | `export *`(types/scanner/python/cmake/xml) |

## 删除与迁移(2026-09-04)

- `lines.ts` 并入 cmake.ts;`cmake-locate` 并入 cmake.ts;stamp 工具并入 configure-actions.ts(文件数净减);
- `locateCmakeTemplateAnchor` **已删除**(旧语义=注释 run 起点上方)→ 由 `locateCmakeTemplateCodeAnchor` 替代(锚在「首条被注释代码行」,`##` 头不参与,msg/install 模板场景用);
- `insertXmlDepElement` 注释参数语义由「独立注释行」改为「元素行尾内联标注」;
- 上层消费统一改经 `index.ts` 桶出口。

## 契约 / 不变量

1. 偏移原语失败一律 `-1/undefined` =「不可动」,上层转 note,不猜写;
2. 区域分类按语言:python(`'`/`"`/三引号、`#`)、cmake(转义串、`#[==[ ]==]`、bracket 参数、行注释)、generic;
3. 插入助手绝不产生不平衡括号或游离分隔符:尾插仅在无尾逗号时补逗号,空容器不加前导逗号;
4. xml 插入锚定 `</package>` 前/依赖区尾——内容绝不落到根闭合标签之后;
5. 追加型命令(install PROGRAMS/TARGETS、rosidl、console_scripts)二次追加 = **内容区纯行追加**:
   先保证块为垂直规范形态(紧凑块一次性重排),幂等按「块内/列表内已含」判定,不靠全文 contains、不依赖标注;
6. 标注(stamp)仅人读/排障,归属与幂等不消费它。

## 消费方

- `configure-actions.ts`(01 一键配置纯层,经 `./anchors` 桶出口);
- `test/suite/anchors.test.ts`(定位层无头单测;与 configure/rename/setup-parser/cmake-parser 套件共同守护,合计 92+ 用例)。

## 状态与下一步

- **状态(2026-09-04):冻结/API 化**。write 整体以 `config/write/api.ts` 对外(本层 = `api.anchors` 命名空间);一键配置的内容语义/高级分析不再扩展;
- 仅维护:缺陷修复、保持行为面;新增形态若确有必要,先入回归再考虑(决策权在上层/未来消费方)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-03 17:19 | 建档:anchors/(types/scanner/python/cmake/xml + index),9 无头用例 |
| 2026-09-03 17:24 | README 中文化(约定:思考英文、产出中文) |
| 2026-09-03 17:38 | 补 lines.ts + python topLevelArgRanges/findKwargSpan;用例 9→12 |
| 2026-09-03 17:41 | 顶部补「理念定位」;全文件理念见 config/write/README |
| 2026-09-04(设计定调) | 定位收敛:不做完整分块 → 多区间增量追加;lines 并入 cmake;scanActiveCalls+locateCmakeInsert;xml.ts lezer 重写 8 类;用例 24 |
| 2026-09-04(同日系列,详见 config/write/README 修改记录) | ① locateCmakeTemplateCodeAnchor(## 头不参与);② 垂直规范形态 + cmakeAppendArgToBlock/findActiveCallByArgs;③ console 规范尾插 insertListItemCanonical + findConsoleScriptsList/consoleListHasItem(支持模块级变量字典与加法式写法);④ package.xml 元素行尾内联标注;⑤ 上层消费收敛为仅经 index 桶出口;locateCmakeTemplateAnchor 删除;用例并入总盘 |
| 2026-09-04 13:22 | 冻结/API 化:anchors 经 write/api.ts 的 anchors 命名空间对外;「下一步」表中接入动作矩阵遗留的措辞撤回(不再扩展一键语义分析) |
