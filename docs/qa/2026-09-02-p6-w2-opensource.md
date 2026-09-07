# P6 W2 下半场:G4 + 三个高分开源库(2026-09-02 傍晚)

## P6-G4 Routine Review & Override
- 迁移 0022 routine_overrides(集×素材幂等);cleared 抹建议/treatment 人工重写(reason 标「人工确认」);accept_all 跳过已有人工裁量。
- annotate_beats 注入裁量;「全部接受降级」按钮+Beat Routine 标签点击循环(montage→transition→beat→full→非Routine)。
- cargo test 3 用例(cleared 抹除/人工标记/幂等跳过)。

## 开源库三件套(优先高分项目,提升成熟度)
| 库 | star | 用途 | 真机验证 |
|---|---|---|---|
| cmdk | ~11k | Cmd+K 命令面板:跳页+89 条素材直达(模糊过滤) | ✅ 浮层/分组/列表实拍 |
| react-resizable-panels v4 | ~5k | 筛片 Browser/Inspector 可拖宽可收起(Group/Panel/Separator 新 API) | ✅ 布局接管实拍;拖拽为库自带 |
| @dnd-kit | ~14k | 故事板 Beat 拖拽(章内+跨章),drop→MoveBeat 撤销链 | 接线+门禁绿;实拍留人工轮 |

## 过程记录
- v4 API 变更(PanelGroup→Group/Separator);jsdom 缺 ResizeObserver→src/test-setup.ts polyfill+vite test 配置。
- dnd useSensors 被放到条件 return 后触发 hooks 顺序错误→上移组件顶部(教训:第三方 hook 一律进顶部 hooks 区)。
- 双实例再次干扰 AX 自动化(/Applications 0.2.4 在后台)——AX 按进程名寻窗在双实例下不可靠,测试前必须清场。
- IME 拦截 cmdk 键入(自动化环境):产品无碍,真实用户英文文件名搜索需切换输入法(记入帮助文档候选)。

## 门禁
cargo test 全量/clippy -D warnings/tsc/vitest 73 全绿;提交 3 个(g4/开源三件套/文档)。
