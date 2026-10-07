# 04 — 全面 DocumentLink(LE 批次,2026-09-30)

> 前置:01-审计、02-补全升级(LC)、03-补全跳转修缮(LD)。
> 起因:用户实测发现 yaml 的 pkg/exec 值被 redhat.vscode-yaml 画了**含引号**的外来下划线(禁用实验定案),
> 由此确立本模块的跳转架构原则,并补齐三格式 pkg/exec 的文件级直达链接。

## 1. 架构原则(用户裁定,2026-09-30)

> **非精确跳转(不要求跳到某一精确行)优先使用文件级跳转(DocumentLink:下划线 + ctrl+单击直达);
> 精确行跳转才用 Definition(F12)。**

机制依据(实证):
- **ctrl+单击 = 链接通道独占**:光标下有 DocumentLink 时鼠标手势只走链接,直达目标文件,定义结果不参与;
- **F12 = 定义通道**:多 provider 结果合并(Pylance 等外来扩展会掺入,扩展侧不可关)——这正是"不稳定"的来源;
- 文件级链接单一、静态、无合并,稳定性最高;xacro 模块 2026-09-07 分流终裁(include=文件级链接/宏变量=精确跳转)同款逻辑。

用户裁定:**pkg/exec 的 F12 定义保留作辅**(ctrl+单击直达不受影响;py 包名字符串恰为可导入模块名时 F12 会叠加
Pylance 模块条目——消除靠用户侧设置 `python.analysis.gotoDefinitionInStringLiteral: false`,产品不改)。

> **勘误(用户指正,2026-09-30)**:xacro 并非"严格二分"——其 Definition 层一直覆盖 include
> (definition-provider.ts 第 1 分支:include filename → 目标文件,F12/Ctrl+点击均可跳),即 xacro include
> 本就是**双通道并存**(链接 + F12),与本批 launch pkg/exec 的形态完全同构。09-07 分层终裁的
> "include → 文件级链接"仅描述链接层的归属,不是"include 无定义"。launch.yaml 经 LD-3(F12)+ LE-2(链接)
> 已成同一形态,架构对齐完成。
> yaml 特有备注:redhat yaml 扩展亦有 definitionProvider(schema 语义,不解析 ROS 包名)→ yaml 的 F12
> 不会被外来条目污染;其外来下划线与我方内容线重叠时 ctrl+click 归属由 VS Code 内部裁决,实测为准。

## 2. 特性表

| 值位 | DocumentLink(本次新增) | F12 定义 | 悬浮 |
|:--|:--|:--|:--|
| py `package=`(Node/LifecycleNode/ComposableNode/ComposableNodeContainer,嵌套各算各) | ✅ → package.xml(优先)/包目录 | 保留 | 已有 |
| py `executable=`(需同调用字面量 package) | ✅ → install-truth 源文件 | 保留 | 已有 |
| xml `<node pkg=/exec=>` | ✅ 同上落点 | 已有 | 已有 |
| yaml node 块 `pkg:` / `exec:` | ✅ 同上落点 | 已有(LD-3) | 已有 |
| 三格式 include 目标 | 已有 | 已有 | 已有 |

范围口径:**值内容**(引号内,与 xml/py 文件链接一致);非字面量(变量/LaunchConfiguration)、未构建、
未命中一律不链(静默口径)。`plugin=`(类名)、`namespace=`/`name=`、`launch_arguments` 键不做。

## 3. yaml 引号线之谜(终审结案,2026-09-30 用户受控实验)

- **现象分解**(用户实测,两线不重叠、位置固定):
  - **固定下划线(值内容,`py_listener.py` 引号内)**= 我方 LE-2 DocumentLink(链接悬浮画线)= 固定文件跳转;
  - **ctrl+hover 时引号字符下的两小段线**(仅在左右引号下方,与内容线不相连)= VS Code"定义可跳转"指示器
    ——我方 yamlCursorAt 的值判定行级宽松,光标压在引号字符上也被判为值位、Definition 照样响应,
    指示器遂在引号字符位置画线;
- **相关条件(用户受控实验,双条件 AND)**:①Definition 下线(yaml 扩展启用)→ 引号段消失;
  ②yaml 扩展禁用(Definition 启用)→ 引号段消失;两者同时在场才出现。
  ——定义指示器本应是 OR 语义(任一 provider 响应即画),AND 实证与静态分析冲突 ⇒ 指示器层
  存在未识别交互,LSP 客户端动态注册/装饰渲染层为嫌疑区,dev 宿主断点可定案,不阻塞;
- ~~"出现时机抖动"假设~~ **作废**(受控实验否定);
- **源码三件套(本轮实证)**:①ctrl+hover 引号线 = VS Code `goto-definition-link` 装饰
  (GotoDefinitionAtPositionEditorContribution):仅在 Ctrl+hover 时绘制,范围 = 各定义结果
  `originSelectionRange` 的并集(多结果)或词范围(单结果),tooltip 多结果时显示"单击以显示 N 个定义";
  ②redhat yaml LS definition **打包产物与开源逐字一致 = 仅锚点别名**(`*alias`→`&anchor`),对普通标量
  不响应 → 其 definition 路径出局(但用户观察到的 yaml 扩展关联仍在,嫌疑转至 LSP 客户端动态注册/
  装饰渲染层或未扫描扩展);③我方 yamlCursorAt 值判定行级宽松,光标压在引号字符上也响应
  → 我方是引号位的响应者之一(消除 = 值位严格判定一行守卫,P3 备忘);
- **判别观察结果(2026-10-01 用户实测)**:①ctrl+hover 无"单击以显示 2 个定义"提示;②值改单引号后
  两段线跟随单引号;③F12 在引号字符上 → 我方 package.xml peek(我方引号位响应实证 → 守卫修复 0f423bf:
  yamlDefinition 整值边界判定,引号位不响应/内容内照常);
- **守卫后线段仍在(用户实测)→ 静态调查硬边界,四事实**:①内置 vscode.yaml=纯语法(1.124 server 扩展
  目录无 yaml 语言服务,仓库 extensions/yaml 仅 grammar+配置)——"内置 yaml 分析器"不存在;
  ②全扩展 createDecorationsCollection/setDecorations 零命中;③1.133 goto-definition 贡献与 main 逐字一致
  且**每次仅画一条连续装饰**——两段分离线段在几何上不可能出自它("=定义指示器"结论撤回);
  ④wordPattern 无处定义(内置/redhat/我方均无)→ 引号位无词,该贡献在引号位早退;
  ⇒ 画线者不在本仓/已装扩展可达代码内,嫌疑=VS Code 内部渲染层或 LSP 客户端深处,静态分析已到边界;
- **定案唯一路径**:VM 上 F5 扩展开发宿主 + 断点(goToDefinitionAtPosition/decorator 层);或打包线索发
  上游 issue(redhat yaml / vscode);
- **归属与承担(用户裁定,不变)**:ctrl+click 实测正确直达 package.xml,功能闭合;yaml 扩展互联不承担;
  引号段为外观层现象,我方守卫保留(F12 语义更干净),不再追;

## 4. 顺带修复

- **yaml-link CRLF 盲区**:lineStarts 原按 `split(/\r?\n/) 行长 + 1` 累加,`\r` 未计入 → CRLF 文件逐行漂移 1 字符
  (range 右滑过闭引号);改从原文按 `\n` 累计(自然计入 `\r`)。
- **补全点号分割核查结论**:py/xml/yaml 的 pkg/exec 补全候选**本就全值锚定**(valueStart/replaceRange→光标,
  逐处核实),无需改动;列表里的 `py_listener`/`py` 碎片来自宿主词级建议(不可关,取证②),已由置顶+detail 压制。

## 5. 批次

| 批次 | 内容 |
|:--|:--|
| LE-0 | 本文档 + 取证 |
| LE-1 | parse 增 scanLaunchNodeRefs(死导出 scanLaunchNodes 物理删除)+ 落点函数共享(resolvePackageTargetUri/resolveExecTargetUri,Definition/Hover/Link 三处同源)+ py 链接 |
| LE-2 | xml `<node pkg=/exec=>` 链接 + yaml node 块链接 + CRLF 修复 |
| LE-3 | 补全全值 range + 测试 + 全量回归 + dev-build + VM 实证(共存结论回填 §3) |

## 7. LF 批次增补(2026-10-01,值解析完备 + 全格式转义)

用户实测两例(引号内前导空格毒害兄弟行 exec 跳转;quoted==unquoted 行为等价)引出值解析完备化:

- **核心裁决**:yaml 解析必须**双路完善**——有引号(单/双)=引号内所有内容严谨包含;无引号=剔首尾
  空格、**中间空格保留**、` #` 注释截断;**转义问题是全体引号问题**(yaml 双引号 `\` 转义/单引号 `''`
  doubling;py `\` 转义 + 三引号 + 字符串内换行;xml 实体解码);py 隐式字符串拼接明确不做(涉及计算)。
- **实现**:core 新增 `parseYamlScalarValue`(yaml 三态扫描器)与 parse 层 `parsePyString`(py 字符串
  扫描器:r 前缀/三引号/转义/续行消隐);yamlSiblingKeyValue、yamlDefinition、yaml-link、
  declaredArgsPy、pyStringKwargInCall 全部接入;grabKwargString 以原文代码态游走取代掩码文本正则
  (三引号值不再被 docstring 掩码吞掉);shared/xml-utils 新增 decodeXmlEntities(5 标准实体)接入
  xml 的 definition/hover/link。
- **设置 `ROS2.launch.yamlNodeMatch`(实验性,默认 true)**:ON=Definition 响应范围覆盖整个字符串
  节点(含引号,引号位 F12 可用);OFF=仅值内容。**文件跳转下划线恒为值内容**(不随设置,与 xml/py
  美术统一)。改后即时生效。
- **"Select JSON schemas = No JSON Schema"答复**:redhat yaml 扩展的 schema 选择器在无关联时的
  正常状态,非缺陷;为 launch.yaml 贡献官方 JSON Schema(结构校验)列 P2 候选。

## 8. LG 批次增补(2026-10-01,定义语义对齐 + 注册开关 + 多行分段)

用户三项反馈的收口:

- **正确语义(LG-1)**:`pkg: " p10_mix_deps_std"` **不应响应**——有引号时前导/后导空格**真正包含进值**
  (正确对齐),引号内内容原样参与解析;宽容 trim 全部移除(yamlSiblingKeyValue 原样返回、
  yamlDefinition/yaml-link 值提取改 parseYamlScalarValue)。级联用例反转为正确语义断言。
- **yaml 定义注册开关(LG-2,用户裁定仅 yaml/重启生效)**:设置 `yamlNodeMatch` 更名
  `ROS2.launch.yamlDefinitionEnabled`(默认 true)——关闭 = .launch.yaml **完全不注册**
  DefinitionProvider(F12 无我方响应,从源头规避引号下指示线),仅影响 yaml;
  py/xml 定义不受影响;链接/悬浮/补全不受影响。providers.ts 注册门控;
  yamlDefinition 的双模式守卫移除(响应范围恒为整节点含引号,注册语义已让位)。
- **多行 include 链接分段(LG-3,用户截图 18-19 行)**:多行属性值的下划线包含换行与缩进 →
  include `file=` 链接**按行分段**:每行剔首尾空白、空白行跳过,按段生成多条同目标 DocumentLink
  (空白不入线);node pkg/exec 同用。yaml 不涉及(值单行)。

## 9. LH 批次增补(2026-10-01,launch 语义诊断:下波浪线全面警告)

用户三项反馈(两段线/exec 残留/设置未找到)+ "开始全面添加警告(下波浪线)"需求:

- **警告范围(用户选定:全面=格式+可解析)**:①格式类(纯静态):pkg/exec 值首尾空白(引号内空格
  是值的一部分)/包名非法字符(含中间空格;exec 另允许点)/可执行名非法字符;②可解析类:未知包
  (工作区+系统名单均未找到;仅 systemAvailable 后判定)、未知可执行或未构建(install-truth 无源;
  仅 pkg 已知时判定)、include 目标不存在或无法解析。severity 全部 warning(下波浪线)。
- **实现**:新 launch-diagnostic-provider(DiagnosticCollection `launch`);yaml 值经
  parseYamlScalarValue 块扫描、xml include 正则+node 属性正则、py scanLaunchNodeRefs;区间=值内容。
- **就绪重算**:PackageMap initialize/systemListChanged/onPackageAtom → reanalyzeAll(防抖 1s)——
  名单就绪后"未知包"自动消除,构建后"未构建"自动消除(杜绝环境未就绪误报,rosmsg RE-1 同款)。
- **设置可见性修复(#4)**:`yamlDefinitionEnabled` 曾带 `deprecationMessage` → VS Code 对弃用设置
  默认在设置界面隐藏(设置搜索"未找到"的直接原因);已移除,更名说明移入 description。
- **两段线(#1)**:LG-3 按行分段的设计表现——多行值按行剔空白生成多条同目标 DocumentLink,
  每段独立 hover/click(目标相同);保留。
- **exec 残留响应(#2)**:LG-1 后所有消费方均有 pkg 字符集门控(` p10…` 不通过),新构建+重载后
  应无响应;若仍见,属新 bug 需带日志回查。
