/**
 * 打开某个历史(已封存)集的只读查看——复用 EpisodePanel 集列表点击"只读查看该集素材"
 * 的既有路径:跳到 /review,再派发 tripcut:view-episode 让 SelectPage 切到只读视角。
 * 这里是唯一实现,搜索侧栏/命令面板都调用它,不重复一遍导航逻辑(R6 Task 5)。
 */
export function openHistoricalEpisode(episodeId: number, title: string): void {
  window.location.hash = "/review";
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("tripcut:view-episode", { detail: { id: episodeId, title } }),
    );
  }, 120);
}
