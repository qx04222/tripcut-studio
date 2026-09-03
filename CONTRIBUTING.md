# Contributing to TripCut Studio

感谢你帮助改进旅剪工作台。项目中文优先，也接受清晰的英文 Issue 和 Pull Request。

## 开始前

- 先搜索现有 Issue，避免重复工作；
- 大型功能或数据迁移先开讨论，明确用户场景与兼容边界；
- 不要提交真实用户素材、账号数据、API Key、模型文件或含隐私的项目数据库；
- 测试视频必须由贡献者拥有再分发权，或来自明确允许使用的公开夹具。

## 本地门禁

提交 Pull Request 前至少运行：

```sh
npm run typecheck
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

播放器、导入、Episode、数据库迁移或交付逻辑的修改，还应提供对应的真实运行证据。源码测试通过不能替代 DMG、原生播放器或干净重启验证。

## 设计原则

- Local-first，未经用户确认不得上传素材；
- 原片只读，所有派生文件写入独立目录；
- 失败必须可见、可恢复，不把部分成功描述成完成；
- 新功能应逐步呈现，不以删除高级能力代替易用性设计；
- 交付剪映优先于复制一个完整剪辑器。

## 许可证

除非明确声明，提交到本仓库的贡献将按 Apache License 2.0 许可。提交者必须有权提供相关代码、文档与测试资产。
