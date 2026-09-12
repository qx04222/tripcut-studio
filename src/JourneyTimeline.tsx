import { useEffect, useRef, useState, type ReactNode } from "react";

import { getJourneyTimeline, type JourneyEntry } from "./api";
import { CoverImage } from "./workspace/ui";

/** 从标准时间取 YYYY-MM-DD 作为天分组的 header;非法/空字符串一律归入未标时间。 */
function dayOf(canonicalTime: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(canonicalTime);
  return match ? match[1] : null;
}

function timeOf(canonicalTime: string): string {
  const match = /T(\d{2}:\d{2})/.exec(canonicalTime);
  return match ? match[1] : "";
}

interface DayGroup {
  day: string;
  entries: JourneyEntry[];
}

function groupByDay(entries: JourneyEntry[]): { days: DayGroup[]; undated: JourneyEntry[] } {
  const days: DayGroup[] = [];
  const undated: JourneyEntry[] = [];
  for (const entry of entries) {
    if (entry.undated) {
      undated.push(entry);
      continue;
    }
    const day = dayOf(entry.canonical_time);
    if (day === null) {
      undated.push(entry);
      continue;
    }
    const last = days[days.length - 1];
    if (last && last.day === day) {
      last.entries.push(entry);
    } else {
      days.push({ day, entries: [entry] });
    }
  }
  return { days, undated };
}

function EntryRow({ entry }: { entry: JourneyEntry }) {
  if (entry.kind === "destination") {
    return (
      <div className="journey-row journey-milestone" data-kind="destination">
        <span className="journey-milestone-marker" aria-hidden="true" />
        <div className="journey-milestone-body">
          <strong>{entry.place_name ?? "未命名地点"}</strong>
          {entry.title ? <span className="journey-milestone-title">{entry.title}</span> : null}
        </div>
        {!entry.undated ? <time>{timeOf(entry.canonical_time)}</time> : null}
      </div>
    );
  }
  return (
    <div className="journey-row journey-clip" data-kind="clip">
      {/* 封面缺失或加载失败都走套件占位(R9 D4),不留坏图「?」。 */}
      <span className="journey-clip-cover" aria-hidden="true">
        <CoverImage src={entry.cover_url} />
      </span>
      <span className="journey-clip-name">{entry.file_name ?? `素材 #${entry.clip_id ?? "?"}`}</span>
      {!entry.undated ? <time>{timeOf(entry.canonical_time)}</time> : null}
    </div>
  );
}

/**
 * `emptyState`:R9 新壳附属区传入套件空状态(带一个动作)替换默认那句;
 * 旧故事板页不传,仍是只读一句话(无任何可交互控件)。
 */
export function JourneyTimeline({ emptyState }: { emptyState?: ReactNode } = {}) {
  const [entries, setEntries] = useState<JourneyEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void getJourneyTimeline()
      .then((next) => {
        if (!mounted.current) return;
        setEntries(next);
      })
      .catch((cause) => {
        if (!mounted.current) return;
        setError(String(cause));
      });
  }, []);

  if (error) {
    return (
      <div className="journey-timeline" aria-label="旅程时间线">
        <p className="journey-timeline-error">旅程时间线未载入：{error}</p>
      </div>
    );
  }

  if (entries === null) {
    return (
      <div className="journey-timeline" aria-label="旅程时间线">
        <p>加载中…</p>
      </div>
    );
  }

  const { days, undated } = groupByDay(entries);

  return (
    <div className="journey-timeline" aria-label="旅程时间线">
      {days.length === 0 && undated.length === 0
        ? (emptyState ?? <p className="journey-timeline-empty">这一集还没有可排列的素材或地点卡。</p>)
        : null}
      {days.map((group) => (
        <section className="journey-day" key={group.day}>
          <header className="journey-day-header">{group.day}</header>
          {group.entries.map((entry, index) => (
            <EntryRow entry={entry} key={`${entry.kind}-${entry.clip_id ?? entry.destination_id ?? index}`} />
          ))}
        </section>
      ))}
      {undated.length > 0 ? (
        <section className="journey-day journey-day-undated">
          <header className="journey-day-header">未标时间</header>
          {undated.map((entry, index) => (
            <EntryRow entry={entry} key={`${entry.kind}-${entry.clip_id ?? entry.destination_id ?? index}`} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
