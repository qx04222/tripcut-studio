/** URL cache lives with one mounted scrubber; per-clip LRU and short URL TTL. */
export class PreviewCache {
  private clips = new Map<number, Map<number, { at: number; url: Promise<string> }>>();
  constructor(private load: (clip: number, seconds: number) => Promise<string>, private limit = 200) {}
  get(clip: number, seconds: number): Promise<string> {
    let entries = this.clips.get(clip);
    if (!entries) { this.clips.clear(); entries = new Map(); this.clips.set(clip, entries); }
    const key = Math.round(seconds * 1000) / 1000;
    let item = entries.get(key);
    if (item && Date.now() - item.at > 60_000) { entries.delete(key); item = undefined; }
    if (item) { entries.delete(key); entries.set(key, item); return item.url; }
    const url = this.load(clip, key).catch(error => { entries.delete(key); throw error; });
    entries.set(key, { at: Date.now(), url });
    if (entries.size > this.limit) entries.delete(entries.keys().next().value!);
    return url;
  }
}
export class PreviewScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: [number, number] | null = null;
  private epoch = 0;
  private busy = false;
  /** `show(seconds, undefined)` = 150 ms 到了、帧还在取(气泡先出时码);`null` = 取不到;字符串 = 可用的帧 URL。 */
  constructor(private cache: PreviewCache, private show: (seconds: number, url: string | null | undefined) => void) {}
  request(clip: number, seconds: number) {
    this.pending = [clip, seconds];
    if (this.timer !== null || this.busy) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 150);
  }
  private async flush() {
    const item = this.pending, epoch = this.epoch;
    if (!item) return;
    this.pending = null; this.busy = true;
    this.show(item[1], undefined);
    try {
      const url = await this.cache.get(...item);
      if (epoch === this.epoch) this.show(item[1], url);
    } catch { if (epoch === this.epoch) this.show(item[1], null); }
    finally {
      this.busy = false;
      this.schedulePending();
    }
  }
  private schedulePending() { if (this.pending) this.request(this.pending[0], this.pending[1]); }
  cancel() { this.epoch++; if (this.timer !== null) clearTimeout(this.timer); this.timer = null; this.pending = null; }
}
