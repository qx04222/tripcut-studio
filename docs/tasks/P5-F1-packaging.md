# 任务卡 P5-F1:DMG 打包与分发

状态:排队。实施:Codex。主审:Claude(执行真实构建)。

## 现实约束(主审拍板)
无 Apple Developer 证书:目标=**本机可安装的 ad-hoc 签名 DMG**;公证与正式签名写成文档化的后续步骤(docs/RELEASE.md),不假装完成。

## 范围
- tauri.conf.json bundle 完整化:productName 旅剪工作台/identifier com.tripcut.studio/icon 全尺寸(用 icons/icon.png 生成 icns——scripts/make-icns.sh 用 iconutil)/DMG 目标
- 外部依赖策略(文档+运行时检测,不捆绑):ffmpeg/ffprobe/whisper-cli 走 PATH 或设置页自定义路径(已有);sidecar venv 用户侧 setup.sh;**首启引导页**:检测缺什么→给一屏中文安装指引(brew 命令可复制)
- `scripts/build-dmg.sh`:npm build+tauri build+ad-hoc codesign(--force --deep -s -)+产出 DMG;把 sidecar/*.py 与 setup.sh 复制进 app Resources 并在应用内定位(dev/prod 双路径解析)
- docs/RELEASE.md:证书/公证/自动更新的完整后续清单(honest)
## 验收
主审执行 build-dmg.sh 成功产出 DMG;安装到 /Applications 启动;首启引导正确检测;核心闭环(导入→筛→导出)在打包版可跑。cargo/前端门禁不回退。

## 纪律
纯写不碰 git 不跑构建(构建由主审);禁改迁移。
