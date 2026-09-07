# Spike S1 / 实验 E0:Mac 剪映 11.3.0 草稿加密实测(2026-08-31)

执行:Claude(主审)经 GUI 自动化(cliclick+AppleScript)在业主机器实机操作。判定原生草稿交付路线生死的第 0 号实验。

## 环境

- 剪映专业版 `/Applications/VideoFusion-macOS.app`,CFBundleShortVersionString = **11.3.0**
- 草稿根:`~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`
- 账号已登录(SVIP),macOS 26(Darwin 27),Apple M5 32GB

## 实验步骤与观察

1. **驱动剪映点「开始创作」**生成空草稿「8月31日」。目录结构关键发现:
   - **时间线文件不再叫 `draft_content.json`,改名为 `draft_info.json`**(pyJianYingDraft/capcut-mate 认识的文件名已变)
   - `draft_info.json`(5636B)与 `draft_meta_info.json`:**密文**(base64 样,`file` 判 ASCII 但非 JSON)——与 Windows 端 `jianying_draft_encrypt_v2` 趋势一致
   - `.backup/*.save.bak`:同样密文
   - `draft_agency_config.json`、`timeline_layout.json`、`draft_settings`:仍明文
   - **`template.tmp`:明文完整经典 schema**(36 顶层键:canvas_config/config/materials/tracks/duration/fps/id...,`new_version:"75.0.0"`,`version:360000`)——证明 11.3.0 内部是「明文构建→落盘加密」,schema 本身未换代
   - `template-2.tmp`(5636B,与 draft_info.json 同大小):同内容的密文版
2. **索引文件 `root_meta_info.json`:明文**,含 `all_draft_store[]`(draft_id/draft_name/draft_fold_path/draft_json_file 直指 draft_info.json)与 `draft_ids[]`。
3. **明文读取金丝雀**:复制「8月31日」为 `TC-plaintext-probe`,用 template.tmp 内容(改 id/name)写成**明文** `draft_info.json`,**不动索引**,重启剪映:
   - ✅ 首页「本地草稿」自动列出探针草稿(文件夹扫描生效,无需注册索引)
   - ✅ 双击打开:**编辑器正常进入,无任何报错**;草稿参数面板正确显示草稿名称/保存位置/时间线01/30.00帧/秒,全部来自明文 JSON

## 结论(对规格 §8 的裁决)

1. **原生草稿交付路线可行**:剪映 11.3.0(Mac)读取端接受明文 `draft_info.json`。我们的交付是单向「写草稿给剪映」,落盘加密只发生在剪映自己保存时,对交付无害。P4 原生草稿层**保留**。
2. 适配层必须按 11.x 事实修正:文件名 `draft_info.json`(非 draft_content.json);schema 以本机 `template.tmp` 为金样;pyJianYingDraft/capcut-mate 的 schema 移植仍有效但文件名与个别字段需对齐 11.x。
3. 版本白名单机制照旧必要:11.3.0 进白名单(本实验即金丝雀);剪映每次升级重跑本实验(建一份明文探针→能否打开)。
4. 风险留白:a) 探针为空时间线,含真实素材轨道的明文草稿尚未验证(P4 第一张任务卡);b) 剪映打开明文草稿后再保存会否加密回写、内容是否保真,未验证;c) 若未来版本读取端也强制解密,本路线死亡→回退稳定交付包(规格已内建)。

## 过程可复现性

探针构造:`cp -R 8月31日 TC-plaintext-probe && rm .locked`,再以 template.tmp 为底改 `id`(新 UUID)/`name` 写入 `draft_info.json`(compact JSON,3959B)。索引备份在 scratchpad(root_meta_info.backup.json),本实验未修改索引。
GUI 自动化坑(记入 QA 手册级经验):剪映是 CEF 应用,辅助功能树不可用,只能截屏+坐标点击;副屏(2560x1440@1x)与主屏(Retina)混用时坐标映射极易错,可靠做法=System Events 把窗口 set position 到主屏已知坐标+前台校验(`frontmost is true` 不通过就放弃点击)再 cliclick;另有并行浏览器自动化会话抢焦点,凡点击前必须校验前台应用。
