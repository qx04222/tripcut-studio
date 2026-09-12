import { createContext, useContext } from "react";
import type { SettingsForm } from "./useSettingsForm";

/** 各分区文件只从这里取表单;`SettingsSheet` 在根上 `Provider` 一次。 */
export const SettingsFormContext = createContext<SettingsForm | null>(null);

export function useSettingsFormContext(): SettingsForm {
  const form = useContext(SettingsFormContext);
  if (!form) throw new Error("useSettingsFormContext 必须在 <SettingsSheet> 之内使用");
  return form;
}
