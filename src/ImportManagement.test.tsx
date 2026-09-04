// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImportManagement } from "./ImportManagement";
const api=vi.hoisted(()=>({ listImportBatches:vi.fn(),cancelImportBatch:vi.fn(),dismissImportNotices:vi.fn(),previewImportRemoval:vi.fn(),removeImportedMaterial:vi.fn() }));
vi.mock("./api",()=>api);
let root:Root; let host:HTMLDivElement;
beforeEach(()=>{
  vi.resetAllMocks(); vi.useFakeTimers(); Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  api.listImportBatches.mockResolvedValue([{id:7,source:"/fixture/card",status:"scanning",total:2,done:0,running:1,failed:0,duplicates:0,imported:1}]);
  api.previewImportRemoval.mockResolvedValue({clips:1,favorites:2,selections:1,cache_entries:3});
  host=document.createElement("div"); document.body.append(host); root=createRoot(host);
});
afterEach(async()=>{ await act(async()=>root.unmount()); host.remove();vi.useRealTimers(); });
const click=async(text:string)=>{ const button=[...host.querySelectorAll("button")].find(b=>b.textContent?.includes(text))!; expect(button).toBeTruthy(); await act(async()=>button.click()); };
it("requires a reviewable confirmation and cancel performs no removal",async()=>{
  await act(async()=>root.render(<ImportManagement selectedIds={[5]} onChanged={()=>{}} />));
  await click("移除选中");
  expect(api.previewImportRemoval).toHaveBeenCalledWith({batch_id:null,clip_ids:[5],all:false});
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("原视频不会删除");
  expect(api.removeImportedMaterial).not.toHaveBeenCalled();
  await click("取消"); expect(api.removeImportedMaterial).not.toHaveBeenCalled();
});
it("stops a scanning batch and preserves its already imported clips",async()=>{
  const changed=vi.fn(); await act(async()=>root.render(<ImportManagement selectedIds={[]} onChanged={changed}/>));
  await click("停止本批"); expect(api.cancelImportBatch).toHaveBeenCalledWith(7);
  expect(api.removeImportedMaterial).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalled();
  expect(host.textContent).toContain("已入库素材保留");
});
it("undo targets only its batch and completes with actual removed count",async()=>{
  const changed=vi.fn(); api.removeImportedMaterial.mockResolvedValue(1);
  await act(async()=>root.render(<ImportManagement selectedIds={[]} onChanged={changed}/>));
  await click("撤销本批"); await click("确认移除");
  expect(api.removeImportedMaterial).toHaveBeenCalledWith({batch_id:7,clip_ids:[],all:false});
  expect(host.textContent).toContain("已移除 1 条素材"); expect(changed).toHaveBeenCalled();
});
