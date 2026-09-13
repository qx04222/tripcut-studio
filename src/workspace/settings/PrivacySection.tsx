import type { JSX } from "react";

import { SectionHeader } from "../ui";
import { Note, SettingsRow } from "./SettingsControls";

export function PrivacySection(): JSX.Element {
  return (
    <>
      <SectionHeader title="隐私与诊断" description="本地优先是默认状态，不是一个开关；这里列出确切留在本机的内容，以及诊断信息的去向。" />
      <div className="settings-sheet-group">
        <SettingsRow title="崩溃报告" help="旅剪不内置崩溃上报；是否发送诊断数据由 macOS 系统设置的“隐私与安全性 › 分析与改进”控制。">
          <span className="settings-sheet-static">由系统设置控制</span>
        </SettingsRow>
      </div>
      <Note title="始终留在本机，绝不上传">
        原片、缩略图、转写文本、GPS 坐标、素材绝对路径与完整项目内容不会离开本机；LLM 增强按调用类型只发送匿名统计量或文字摘要
        (见下方本分区的发送内容明细)，导出包只在你主动交付时才会离开本机。
      </Note>
      <Note title="发送内容明细">
        AI 描述只发送时长、尺寸、基础分析数值与运镜数值;不发送文件名、封面帧、图片、视频、音频、绝对路径或 GPS。
        导演问答只发送当前筛选统计、精选清单文字摘要和你的问题，不发送素材帧或转写。
        叙事编排只发送匿名的素材/片段编号、时长、尺寸、八维标签与同镜头分组数值,不发送文件名、拍摄时间、GPS、转写或频道记忆。所有输入通过标准输入传给你锁定的 provider，不出现在进程参数中。
      </Note>
    </>
  );
}
