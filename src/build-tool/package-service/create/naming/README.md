# naming/ — 命名、校验与生成文件模型

> create 子域的命名/校验**单一事实来源**。零生成器依赖;校验消息走 l10n(names.ts 自 2026-10-04 批13、package-folder 自 2026-10-07;可经 _vscode-stub 无头单测)。
> 创建:2026-09-04 17:11(等价变换分类后补各子目录 README)。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `names.ts` | 四域合一:① 包名域 `validatePackageName` / `PACKAGE_NAME_RE`;② 文件基名域 `FILE_BASE_RE` / `NAME_MAX_LENGTH`(=250) / Windows 保留设备名 / `parseFileBaseList` / `validateFileBaseName(s)`;③ 节点名域 `NODE_NAME_RE` / Python 3 关键字黑名单 / `parseNodeNames` / `validateNodeNamesInput`;④ 映射与顺延 `CppNodeSpec` / `CppNodeInput` / `toSpec` / `toNodeName`(`-`→`_`) / `disambiguateNodeNames`(冲突顺延 `_1/_2`) | logger(注入式,无头回退 console) |
| `generated-file.ts` | `GeneratedFile` **唯一定义**(`path` / `content` / `directory?` / `exec?`:true = 写盘后需可执行位,仅 install(PROGRAMS) 安装的 Python 脚本,符号安装下软链回源无 +x 会被 ros2 的 X_OK 过滤)——两生成器与写盘共用一份 | — |
| `package-folder.ts` | 包文件夹名冲突校验:目标目录已存在同名文件夹 → 报冲突;`exists` 由调用方注入(便于测试) | logger |

## 语义锚点(create/README §4/§7,不因搬移改变)

- **输入 = 文件基名,原样写盘**(真实对应,不顺延);文件层冲突由输入框校验兜底(格式/保留名/同框去重);
- **顺延只发生在节点名层**:有损映射(`-`→`_`)结果冲突时对节点名追加 `_1/_2`,文件基名不动;
- C++ 源/脚本(cpp-dual)= 宽域基名 + 映射顺延;Python 模块(mixed/ament_python)= 标识符恒等(文件 === 模块名 === 节点名,含关键字/保留名/长度检查);
- 包名规则取官方 ament 规范(小写开头、禁连续/结尾下划线),另禁 `test`。

## 边界与依赖方向

- 被依赖方:`../generate`(门面转发)、`../deps/dep-parse`(取 `validatePackageName`)、`../kinds`(取 `CppNodeSpec` 类型)、`../command`(经门面);
- 本目录**不 import** 生成器/模板/dep——消除历史倒挂(曾 py/dep 反向 import create-cpp-package)。

## 扩展位(后续调整入口)

- 命名规则变化(如放宽/收紧标识符、追加保留名、Python 版本关键字表更新):只改 `names.ts`,全链路自动生效;
- 文件模型变化(写盘前预览/校验/新字段):只改 `generated-file.ts`。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-07 | parseNodeNames 5 条校验消息 l10n 化(批13 平行实现漏网,validateNodeNamesInput 同链受益;en 界面不再反串中文)+ package-folder 冲突报错 l10n 化 |
| 2026-09-29 | 文档补登:generated-file.ts 行补 `exec?` 字段(2026-09-06 c650761 加入,PROGRAMS 脚本 +x,当时未入文档) |
| 2026-09-04 17:11 | 建档:create/ 分类后补子目录 README——naming/(四域合一 names.ts + GeneratedFile + package-folder)职责与语义锚点 |
