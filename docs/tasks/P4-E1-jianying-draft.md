# 任务卡 P4-E1:剪映原生草稿生成(明文写入+白名单+金丝雀)

状态:排队(D2 后派发)。实施:Codex。主审:Claude(含真机剪映金丝雀)。

## 依据(全部一手实测,见 spikes/s1-e0-draft-encryption/REPORT.md)
- 剪映 Mac 11.3.0:时间线文件 = **draft_info.json**(非 draft_content.json);落盘加密但**读取端接受明文**;schema 金样 = 草稿目录 template.tmp(36 顶层键,new_version "75.0.0",version 360000);草稿根 `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`,文件夹扫描自动收录(无需动索引);时间单位微秒。

## 范围
- `core/jianying.rs`:草稿生成器——输入=精选(段/整条,按 story_order);产出草稿文件夹:`draft_info.json`(明文,以金样 schema 为底:tracks 一条视频轨,segments 逐条引用**原片绝对路径**,target_timerange 顺序拼接/source_timerange=入出点微秒换算)+ 最小 draft_meta_info.json(明文,照 pyJianYingDraft 结构)+ 必要空目录;金样模板以 Rust 常量内嵌(从 REPORT 附的 template.tmp 字段结构手写 serde 结构体,**不 include 用户机器文件**)
- 版本白名单:读 `/Applications/VideoFusion-macOS.app/Contents/Info.plist` CFBundleShortVersionString;白名单常量 ["11.3.0"];白名单外→交付页只出稳定包并明示原因(规格 §8 显式降级)
- 写前自检:先写临时目录→回读 serde 解析+关键字段校验→原子 rename 进草稿根;失败自动降级稳定包
- 交付页:「生成剪映草稿(实验)」按钮(白名单内才亮),成功后提示在剪映里打开;exports 表记 tier='native_draft'
- 转写 SRT 若有:同时放草稿文件夹旁(不进时间线,剪映内手动导入,说明写进交付说明)
## 非目标
字幕轨/音乐轨进草稿;自动打开剪映;加密写入;10.x 兼容。

## 验收
cargo ≥8(schema 序列化关键字段/微秒换算/白名单判定/回读自检失败降级/原子写);五门全绿。**真机金丝雀(主审)**:生成草稿→剪映列表出现→打开→时间线上素材顺序与入出点正确→回报截图。

## 纪律
纯写不碰 git 不跑构建;**绝不写入草稿根之外的剪映目录,绝不改剪映既有草稿**;迁移不加(exports 已有 tier)。
