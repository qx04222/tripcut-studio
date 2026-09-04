// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryPanel } from "./LibraryPanel";
const api=vi.hoisted(()=>({listLibraries:vi.fn(),createLibrary:vi.fn(),setLibraryHidden:vi.fn(),switchLibrary:vi.fn()}));
vi.mock("./api",()=>api);
let root:Root;let host:HTMLDivElement;
const registry={active:"original",libraries:[{id:"original",name:"旧库",hidden:false},{id:"a",name:"新库",hidden:false}]};
beforeEach(()=>{vi.resetAllMocks();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});api.listLibraries.mockResolvedValue(registry);host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const click=async(text:string)=>{await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent===text)!.click());};
it("switches only after confirmation and explains pending work",async()=>{
  await act(async()=>root.render(<LibraryPanel/>));await act(async()=>host.querySelector<HTMLButtonElement>(".library-current")!.click());
  expect(host.textContent).toContain("返回该库时继续");
  await click("切换");expect(api.switchLibrary).not.toHaveBeenCalled();await click("取消");expect(api.switchLibrary).not.toHaveBeenCalled();
  await click("切换");await click("保存并切换");expect(api.switchLibrary).toHaveBeenCalledWith("a");
});
it("hides without switching or deleting and offers restoration",async()=>{
  api.setLibraryHidden.mockResolvedValue({...registry,libraries:[registry.libraries[0],{...registry.libraries[1],hidden:true}]});
  await act(async()=>root.render(<LibraryPanel/>));await act(async()=>host.querySelector<HTMLButtonElement>(".library-current")!.click());
  await click("从列表移除");expect(api.setLibraryHidden).toHaveBeenCalledWith("a",true);expect(api.switchLibrary).not.toHaveBeenCalled();
  expect(host.textContent).toContain("恢复到列表");
});
