import { useEffect, useState } from "react";
import { createLibrary, listLibraries, setLibraryHidden, switchLibrary, type LibraryRegistry } from "./api";

export function LibraryPanel() {
  const [registry, setRegistry] = useState<LibraryRegistry | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => { let active = true; void listLibraries().then((value) => { if (active) setRegistry(value); }).catch((e) => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const current = registry?.libraries.find((library) => library.id === registry.active);
  return <div className="library-panel">
    <button className="library-current" type="button" aria-expanded={open} onClick={() => { setOpen(!open); setTarget(null); }}>
      <small>素材库 ▾</small><strong>{current?.name ?? "管理素材库"}</strong>
    </button>
    {open ? <div className="library-drawer" aria-label="素材库管理">
      <p>每个库独立保存素材、筛选和集。切换会等待运行中的任务结束并重启；尚未开始的任务会在返回该库时继续。</p>
      {registry?.libraries.filter((l) => !l.hidden).map((l) => <div className="library-entry" key={l.id}>
        <strong>{l.name}</strong>
        {l.id === registry.active ? <small>当前库</small> : <>
          <button disabled={busy} onClick={() => setTarget(l.id)}>切换</button>
          <button disabled={busy} onClick={() => void run(async () => setRegistry(await setLibraryHidden(l.id, true)))}>从列表移除</button>
        </>}
      </div>)}
      {target ? <div role="alert" className="library-confirm"><p>切换到「{registry?.libraries.find((l) => l.id === target)?.name}」并重启？当前库会保留。</p>
        <button disabled={busy} onClick={() => void run(async () => { await switchLibrary(target); })}>{busy ? "正在保存并切换…" : "保存并切换"}</button>
        <button disabled={busy} onClick={() => setTarget(null)}>取消</button>
      </div> : null}
      <form onSubmit={(event) => { event.preventDefault(); void run(async () => { const next = await createLibrary(name); setRegistry(next); setName(""); setTarget(next.libraries.at(-1)!.id); }); }}>
        <label>新库名称<input aria-label="新库名称" maxLength={80} value={name} onChange={(e) => setName(e.currentTarget.value)} /></label>
        <button disabled={busy || !name.trim()}>新建空白库</button>
      </form>
      <details><summary>已移除的库</summary><p>移除只隐藏列表项，不删除库文件或原视频，可随时恢复。</p>
        {registry?.libraries.filter((l) => l.hidden).map((l) => <div className="library-entry" key={l.id}><span>{l.name}</span><button disabled={busy} onClick={() => void run(async () => setRegistry(await setLibraryHidden(l.id, false)))}>恢复到列表</button></div>)}
      </details>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
