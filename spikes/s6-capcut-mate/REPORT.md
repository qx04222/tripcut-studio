# P0 Spike S6 — capcut-mate 可复用性评估

日期:2026-08-31。范围:只读分析,未改动 tripcut 仓库其他目录,未写剪映草稿目录。
克隆位置(scratchpad,不入库):
- `capcut-mate` @ `https://github.com/Hommy-master/capcut-mate` (shallow clone, HEAD 2026-08-31 `优化字幕，增强字幕兼容性。`)
- `pyJianYingDraft` @ `https://github.com/GuanYixuan/pyJianYingDraft` (shallow clone, HEAD 2026-07-08 `Docs: Readme updates`, v0.3.0)

背景:`docs/specs/2026-08-31-tripcut-design.md` §8 把"试原生草稿"定义为"pyJianYingDraft 思路,参考 capcut-mate";§0 记录本机剪映专业版 **11.3.0**(`VideoFusion-macOS.app`),草稿根 `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`,E0(明文/加密判定)尚未完成。本 spike 目的是判断 capcut-mate 能不能直接顶上 P4 原生草稿这块拼图,以及它对 E0 有没有旁证。

---

## a) 支持的剪映版本范围 / 10.x·11.x 处理 / 加密解密逻辑

**版本范围:代码里没有版本白名单、没有 schema 版本分支。** 全仓 grep `version|schema版本` 在
`src/pyJianYingDraft/script_file.py`(865 行,负责生成 `draft_content.json`)里**零命中**——它无条件按同一套字段结构写 JSON,不判断目标剪映装的是哪个版本,也不像设计文档设想的那样"读 VideoFusion Info.plist 做版本白名单→写前 probe→写后回读校验"。这套 probe/校验协议在 capcut-mate 里不存在,是 tripcut 自己要造的。

上游 pyJianYingDraft 的 README(功能矩阵表)倒是有版本语境,但只标到 **5.9** 和 **10.8**("新版剪映"),完全没有出现过 `11.` 开头的版本号——即没有任何一方的代码或文档对 11.3.0 做过验证或声明兼容。这与本机安装的剪映专业版 11.3.0 之间有明确的版本落差,是"能不能用"的最大未知数。

**加密/解密:两个仓库都没有 encrypt/decrypt/AES/cipher 实现**(`grep -rniE "encrypt|decrypt|\bAES\b|cipher"` 全仓零命中,capcut-mate 和 pyJianYingDraft 都一样)。但有一条强旁证:上游 pyJianYingDraft 新增了 `pyJianYingDraft/draft_content_loader.py`(capcut-mate 里**没有**这个文件,说明是 capcut-mate 分叉之后上游才加的),其 `load_draft_content()` 先尝试 `json.loads(...utf-8...)`,失败就抛 `DraftContentLoadFailed`,报错文案是:

> "草稿内容 '%s' 不是合法的明文 JSON；如需读取本机特殊格式草稿，请通过 DraftFolder(..., fallback_loader=...) 提供后备读取器"

即上游作者**知道**存在"本机特殊格式"的 `draft_content.json`(读不出明文 JSON 的情况),但**没有内置解码器**——把这个口子留给调用方自己接一个 `fallback_loader`。这不等于证实 11.3.0 加密,但说明"某些环境下 draft_content.json 不是明文 JSON"是上游实测遇到过的真实情况,不是 tripcut 团队多虑。**E0 实验(在本机剪映里新建草稿、人工读一次 draft_content.json)仍然是唯一能判定 11.3.0 到底明文还是加密的方法,capcut-mate/pyJianYingDraft 都不能替代这一步。**

## b) macOS 端草稿路径怎么探测

**没有探测逻辑,是硬编码的 Windows 路径。** `config.py`:

```python
# 剪映草稿保存路径（下载剪映草稿保存位置）-- 云渲染必需配置
#DRAFT_SAVE_PATH = "C:/Users/Administrator/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft"
DRAFT_SAVE_PATH = "C:/Users/1/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft"
```

`DraftFolder.__init__(self, folder_path: str)`(`src/pyJianYingDraft/draft_folder.py`)只是校验传入路径是否存在,不做任何"当前操作系统 → 对应草稿根目录"的映射;调用方必须自己算出路径再传进去。全库没有 `Movies`、`JianyingPro`(不含 Windows 路径里的那个)、`com.lveditor.draft` 之外的任何 macOS 特有路径常量,也没有 `platform.system()` 分支来切换根目录。

README/桌面客户端提到的"macOS 支持"实际指的是 **Electron 桌面壳**(`desktop-client/`,`electron 31.7.6`,`process.platform === 'darwin'` 只用来选 `.icns` 图标和沙箱权限引导文档 `docs/macos_sandbox_setup.md`)——它是一个可以在 Mac 上跑的**客户端 UI**,用来调用云端 API,不代表底层"剪映自动化控制"在 macOS 上跑。真正落地草稿到磁盘/驱动剪映导出的 `jianying_controller.py` 顶部直接写死:

```python
if sys.platform != "win32":
    raise ImportError("JianyingController is only available on Windows platform")
```

且依赖 `pyautogui`、`uiautomation`(Windows UI Automation COM)、`taskkill /F /T /IM JianyingPro.exe`(`src/utils/jianying_export_cleanup.py`)。**这部分在 macOS 上完全不可用,连编译都过不了(import 直接抛异常)。**

结论:capcut-mate 对我们最关心的"macOS 上探测/写入 `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`"这件事贡献为零,这条探测逻辑要 tripcut 自己写。

## c) draft_content.json 生成 schema 覆盖的能力 / 入出点单位

覆盖面相当完整,`script_file.py::ScriptMaterial.export_json()` 落地的字段包括(节选):`audios / videos / stickers / texts / audio_effects / audio_fades / animations / video_effects / speeds / masks / transitions / effects(含 filter/花字/气泡) / mix_modes / canvases / digital_humans / beats / chromas / color_curves` 等——即视频、图片、音频、贴纸、字幕(文本轨)、转场(`transitions`,通过 `add_videos` 的 transition 字段接入,`metadata/transition_meta.py` 提供转场元数据)、特效/滤镜、蒙版、关键帧、变速全部有对应的导出结构。对外通过 FastAPI 暴露成 37 个 REST 端点(`src/router/v1.py`),其中与轨道/素材相关的有 `add_videos / add_audios / add_images / add_sticker / add_captions / add_effects / add_filters / add_masks / add_keyframes / add_text_style / create_draft / save_draft` 等,`add_captions` 支持字号/颜色/描边/阴影/对齐(横竖排)等字幕样式细节。

**入出点单位:微秒(microsecond),不是毫秒也不是帧。** `src/pyJianYingDraft/time_util.py`:

```python
SEC = 1000000  # 一秒=1e6微秒
class Timerange:
    start: int     # 起始时间, 单位为微秒
    duration: int  # 持续长度, 单位为微秒
```

`tim()` 支持 `"1h52m3s"` 这类字符串或直接传微秒数;`export_json()` 原样把整数微秒写进 `draft_content.json`。HTTP 层的 `schemas/timelines.py`(`TimelineItem.start/end: int`)延续同一单位。这与 tripcut 设计文档 §8 的"帧精确协议(回读首尾 PTS 与期望比对)"是同一量级(PTS 通常也是整数时基),对接时只需把秒级/帧级时间换算成整数微秒即可,没有额外的取整误差来源。

## d) 架构能否被 Rust 侧复用

**不能直接依赖,只能参考/移植 schema。** 三个理由:

1. **语言边界**:核心是纯 Python(`src/pyJianYingDraft/*.py`,零 C 扩展、零原生依赖),没有暴露 C ABI 或 FFI 接口,Rust 没有直接 `use` 的入口。要复用只能:(i) 把 Python 进程当子进程跑(拉起 FastAPI 服务或裸调 CLI),用 HTTP/stdin-stdout 传 JSON;或 (ii) 把 schema 逻辑照着抄成 Rust struct + serde。
2. **HTTP API 是 SaaS 形态,不是本地库**:`v1.py` 的 37 个端点里,草稿生成部分(`create_draft/add_*/save_draft`)是无状态的、可以本地跑的部分;但 `gen_video`(云渲染,即真正驱动剪映导出成片)`src/service/gen_video.py` 强制走 `apiKey` + 积分校验(`get_user_points` / `INSUFFICIENT_ACCOUNT_BALANCE`),背后是 Hommy 自营的付费云渲染集群(`capcut-mate.jcaigc.cn`,Windows 机器池跑 `JianyingController` 自动化)。这一半功能是**别人的付费服务**,不是能自托管、更不是能塞进 Rust 二进制的东西。
3. **子进程方式技术上可行但代价不小**:如果只要"生成 draft_content.json 明文/schema"这一半(草稿生成部分是纯 Python、无 Windows 依赖、可在 macOS 跑),理论上可以 (a) vendor 这份 Python 代码 + 用 `pip`/`uv` 装进 tripcut 的构建产物,Rust 侧用子进程调用一个薄 CLI 包装;或 (b) 直接把 `script_file.py` 里那套字段结构在 Rust 里重新实现一遍(serde struct + 手写 export)。给定 tripcut 是单一 Rust/Tauri 桌面应用、要考虑打包体积和"不能依赖用户装 Python/uv"这个约束,**(b) 照抄 schema 明显更适合我们的产品形态**——子进程方案会把"要不要在用户机器上再装一个 Python 运行时"这个复杂度背回来,与 tripcut 的单文件桌面应用定位冲突。

所以复用建议方向是**读代码抄 schema 结构(字段名、嵌套层级、微秒单位、`material_id`/`global_id` 关联方式),用 Rust 重新实现导出器**,而不是把 capcut-mate 当依赖挂进 Cargo.toml 或作为常驻子进程。

## e) 许可证

**Apache License 2.0**,capcut-mate 和 pyJianYingDraft 都是(仓库根 `LICENSE` 文件均以 `Apache License / Version 2.0` 开头)。capcut-mate 的 `src/pyJianYingDraft/jianying_controller.py` 文件头还留了原始 Apache 2.0 声明并注明 `Modified by Hommy <taohongmin@sina.cn> on 2026-06-12`,说明 capcut-mate 是 fork 自 pyJianYingDraft 早期版本、按 Apache 2.0 允许的方式二次修改并保留了版权声明——**对 tripcut 而言两者都可以照抄字段结构/思路,不构成许可证障碍**(Apache 2.0 允许阅读、参考、甚至整段复制代码,只需保留版权声明和 LICENSE、注明改动;不要求开源 tripcut 自己的代码)。

---

## 与 pyJianYingDraft 上游的对比:谁的 schema 更新、谁更贴近 11.x

| 维度 | capcut-mate(vendored 副本) | pyJianYingDraft(上游) |
|---|---|---|
| 最近提交(本仓库整体) | 2026-08-31(今天,高频日更) | 2026-07-08(约 7 周前) |
| 最近触碰 `pyJianYingDraft` 核心目录的提交 | 2026-08-31(`优化字幕兼容性`/`优化字体兼容性问题`——capcut-mate 独立维护了自己 fork 出来的这份代码,持续在打兼容性补丁) | 同上游自身节奏,0.3.0 版(2026-07-08 打的 tag) |
| 代码结构 | 单文件 `script_file.py`(865 行 monolith),无 `draft_content_loader.py` | 已重构拆分为 `_script_file_tracks.py` / `_script_file_segments.py` / `_script_file_template.py`,新增 `draft_content_loader.py`(带 fallback_loader 钩子应对非明文草稿) |
| 版本语境(README 功能矩阵) | 无版本矩阵,只堆功能列表 | 有"5.9 支持状态 / 新版剪映支持状态"两栏表格,但最高只标到 **10.8**,没有 11.x |
| 对"草稿可能不是明文 JSON"的处理 | 无任何相关代码或注释 | 显式设计了 `fallback_loader` 扩展点并在异常文案里点名"本机特殊格式草稿" |

**结论:两者都没有对 11.x 做过验证,谁都不能替代 E0 实验。** 但方向不同——capcut-mate 更新更频繁,重点在于**打磨"生成"侧的兼容性补丁**(字幕、字体这类容易在不同剪映版本渲染错位的细节)和产品化(Electron 客户端、云渲染 SaaS);pyJianYingDraft 更新虽然慢(v0.3.0,距今 7 周未动),但它是"读"侧走得更远的一方——`draft_content_loader.py` + `fallback_loader` 是目前两个项目里唯一直面"草稿文件格式可能不是纯 JSON"这件事的代码,对应设计文档 E0 实验想验证的正是这一点。如果 tripcut 未来要做"读取剪映已有草稿再回写"(而不仅仅是从零生成),pyJianYingDraft 的这个扩展点值得多看一眼;如果只做"从零生成、单向导出给剪映打开",两者的**写入 schema 字段结构基本一致**(capcut-mate 本就是 pyJianYingDraft 早期版本的 fork),抄哪个的结构问题都不大,但抄 pyJianYingDraft 更贴近"最新"字段命名(经过一轮 `Refactor: Remove snake case classes`/`Remove generic from class Track` 之类的清理)。

---

## 复用建议

**仅抄 schema,不直接依赖。** 具体到 tripcut 的 Rust 实现:

1. 不要把 capcut-mate 或 pyJianYingDraft 拉进构建产物(无论是 Cargo 依赖、子进程还是打包一个 Python 运行时)——两者都是纯 Python,和 tripcut 单一 Rust/Tauri 桌面应用的打包/分发模型不匹配,子进程方案会把"用户机器要不要装 Python"这个复杂度背回来。
2. 把 `src/pyJianYingDraft/script_file.py`(capcut-mate 版,更贴近它们实测过的字段)和上游 `pyJianYingDraft/_script_file_*.py`(结构更新、更贴近最新剪映客户端命名习惯)两份一起对照读,把 `draft_content.json` 的顶层结构(`materials.*` 各子列表 + `tracks` + 微秒时间单位 + `material_id`/`global_id` 关联方式)整理成 tripcut 自己的 Rust struct(serde),按 §8 设计的"版本白名单 + 写前 probe + 写后回读校验"协议接进去——这套协议本来就是 capcut-mate 没有的,得自己写。
3. 转场(`transitions`)、字幕(`add_captions` 的样式字段)、关键帧这几块 capcut-mate 的 schema 覆盖面比较全,可以直接当"字段清单"抄,省得自己从剪映应用逆向。
4. E0 实验(本机剪映 11.3.0 新建草稿、人工判定 `draft_content.json` 明文/加密)**仍然必须做**,两个仓库都没有覆盖到 11.x,且都没有内置解密逻辑——如果 E0 判定是加密,原生草稿路线(整条 P4)按设计文档裁决直接撤下,capcut-mate 的 schema 参考价值也随之归零(生成的明文 JSON 剪映读不进去)。

## 风险清单

- **版本落差未验证**:capcut-mate/pyJianYingDraft 都只验证到剪映 10.8 附近,本机是 11.3.0,字段结构、动画/特效 ID、`material_id` 生成规则都可能已经变化而两边代码都没跟上——"字段名对得上"不等于"11.3.0 打得开"。
- **加密不确定性未消解**:E0 仍未完成,pyJianYingDraft 的 `fallback_loader` 设计是"某些环境读不出明文 JSON"的旁证,不是"11.3.0 一定加密/一定不加密"的证据,不能拿这条旁证代替实验结论。
- **macOS 路径/进程自动化完全空白**:capcut-mate 的路径探测是硬编码 Windows 路径,自动化控制器(写前 probe、导出触发、导出失败清理/强杀进程)显式拒绝非 Windows 平台——这部分 100% 要 tripcut 自己写,不是"参考"就能省下来的工作量,是从零开始。
- **capcut-mate 的"cloud rendering"部分不可自托管参考**:`gen_video` 走的是作者自营付费 SaaS(`apiKey`+积分),背后的 Windows 云渲染机器池代码大概率没有开源(仓库里只有客户端调用逻辑,没看到渲染集群侧代码),不要指望"抄一抄就能自建云渲染"。
- **两份 schema 存在细节漂移**:capcut-mate 是 pyJianYingDraft 早期版本 fork 后各自独立演化(capcut-mate 加了花字/关键词阴影等自己的兼容性补丁,pyJianYingDraft 做了类名重构),照抄任何一份都要先确认字段名在另一份里是否已经改名,避免抄出一份两边都不新鲜的中间态。
- **单元测试覆盖对 tripcut 判断力有限**:两仓库测试(`tests/`)是针对各自 Python 实现的单元测试,不能作为"剪映 11.3.0 能打开这份 draft_content.json"的证据——唯一权威证据来源仍是"剪映应用本身打开文件"这一步,E0 之后如果走 P4 也需要类似的人工验证闭环。
