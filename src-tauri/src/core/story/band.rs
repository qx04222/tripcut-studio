//! Episode-local band placement. Source clip chapters and files are never changed.
use super::*;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BandLayout {
    pub chapter_order: Vec<i64>,
    pub assignments: BTreeMap<String, Option<i64>>,
}

#[derive(Debug, Deserialize)]
pub struct BandOrderItem {
    #[serde(flatten)]
    pub item: StoryOrderRef,
    pub chapter_id: Option<i64>,
}

pub fn layout(connection: &Connection, episode_id: i64) -> Result<BandLayout> {
    let raw = settings::setting_value(connection, &format!("internal.band.layout.{episode_id}"))?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|error| CoreError::Story(error.to_string())))
        .transpose().map(|value| value.unwrap_or_default())
}

pub(super) fn save_layout(connection: &Connection, episode_id: i64, layout: &BandLayout) -> Result<()> {
    let value = serde_json::to_string(layout).map_err(|error| CoreError::Story(error.to_string()))?;
    connection.execute("INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        params![format!("internal.band.layout.{episode_id}"), value])?;
    Ok(())
}

pub(super) fn remap_chapter(connection: &Connection, episode_id: i64, source: i64, target: i64) -> Result<()> {
    let mut saved = layout(connection, episode_id)?;
    saved.chapter_order.retain(|id| *id != source);
    for chapter in saved.assignments.values_mut() { if *chapter == Some(source) { *chapter = Some(target); } }
    save_layout(connection, episode_id, &saved)
}

fn live_chapter_ids(connection: &Connection, episode_id: i64) -> Result<HashSet<i64>> {
    Ok(connection.prepare("SELECT id FROM chapters WHERE episode_id=?1 AND tombstone=0")?
        .query_map([episode_id], |row| row.get(0))?.collect::<std::result::Result<_, _>>()?)
}

pub(super) fn apply_layout(connection: &Connection, episode_id: i64, chapters: &mut [Chapter], items: &mut [StoryItem]) -> Result<()> {
    let saved = layout(connection, episode_id)?;
    chapters.sort_by_key(|chapter| saved.chapter_order.iter().position(|id| *id == chapter.id).unwrap_or(usize::MAX));
    let valid = live_chapter_ids(connection, episode_id)?;
    for item in items {
        if let Some(chapter) = saved.assignments.get(&item.key) {
            // A stale override inherits the source; explicit unassigned stays None.
            if chapter.is_none_or(|id| valid.contains(&id)) { item.chapter_id = *chapter; }
        }
    }
    Ok(())
}

pub fn set_order(connection: &mut Connection, episode_id: i64, order: &[BandOrderItem], chapter_order: &[i64]) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if active_episode_id(&transaction)? != episode_id { return Err(CoreError::Story("当前集已切换".into())); }
    let valid = live_chapter_ids(&transaction, episode_id)?;
    for id in chapter_order.iter().copied().chain(order.iter().filter_map(|item| item.chapter_id)) {
        if !valid.contains(&id) { return Err(CoreError::Story("目标章不在当前集".into())); }
    }
    if chapter_order.iter().copied().collect::<HashSet<_>>().len() != chapter_order.len() { return Err(CoreError::Story("章节顺序重复".into())); }
    let mut assignments = BTreeMap::new();
    let mut seen = HashSet::new();
    for entry in order {
        validate_order_ref(&entry.item)?;
        if !is_video_clip_in_episode(&transaction, entry.item.clip_id, episode_id)? { return Err(CoreError::Story("素材已离线或不在当前集".into())); }
        ensure_selected(&transaction, &entry.item, episode_id)?;
        let key = story_key(&entry.item.item_kind, entry.item.clip_id, entry.item.segment_id);
        if !seen.insert(key.clone()) { return Err(CoreError::Story("镜头顺序重复".into())); }
        let source: Option<i64> = transaction.query_row("SELECT chapter_id FROM clips WHERE id=?1", [entry.item.clip_id], |row| row.get(0))?;
        if entry.chapter_id != source.filter(|id| valid.contains(id)) {
            assignments.insert(key, entry.chapter_id);
        }
    }
    transaction.execute("UPDATE story_order SET tombstone=1 WHERE episode_id=?1 AND tombstone=0", [episode_id])?;
    for (position, entry) in order.iter().enumerate() { upsert_story_order(&transaction, &entry.item, episode_id, position as i64)?; }
    save_layout(&transaction, episode_id, &BandLayout { chapter_order: chapter_order.to_vec(), assignments })?;
    transaction.commit()?;
    Ok(())
}

/// Preserve segment identity, ratings and AI provenance. Expected bounds prevent lost updates.
pub fn trim(connection: &mut Connection, episode_id: i64, segment_id: i64, expected: [i64; 2], bounds: [i64; 2]) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if active_episode_id(&transaction)? != episode_id { return Err(CoreError::Story("当前集已切换".into())); }
    let old: Option<(i64, i64, i64)> = transaction.query_row(
        "SELECT s.in_ticks, s.out_ticks, c.duration_ticks FROM segments s JOIN clips c ON c.id=s.clip_id
         WHERE s.id=?1 AND s.kind='select' AND s.tombstone=0 AND c.kind='video'
           AND c.missing_since IS NULL AND (c.episode_id=?2 OR c.episode_id IS NULL)",
        params![segment_id, episode_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
    let Some((start, end, duration)) = old else { return Err(CoreError::Story("片段已不可编辑".into())); };
    if [start, end] != expected { return Err(CoreError::Story("片段已改变，请重试".into())); }
    if bounds[0] < 0 || bounds[1] <= bounds[0] || bounds[1] > duration { return Err(CoreError::Story("入出点超出素材边界".into())); }
    transaction.execute("UPDATE segments SET in_ticks=?2, out_ticks=?3 WHERE id=?1", params![segment_id, bounds[0], bounds[1]])?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn ordered(connection: &Connection, episode_id: i64, mut items: Vec<(BandItemRef, i64)>) -> Result<Vec<BandItemRef>> {
    let saved = layout(connection, episode_id)?;
    let mut chapters: Vec<i64> = connection.prepare("SELECT id FROM chapters WHERE episode_id=?1 AND tombstone=0 ORDER BY start_at,id")?
        .query_map([episode_id], |row| row.get(0))?.collect::<std::result::Result<_, _>>()?;
    chapters.sort_by_key(|id| saved.chapter_order.iter().position(|candidate| candidate == id).unwrap_or(usize::MAX));
    for (item, _) in &mut items {
        if let Some(chapter) = saved.assignments.get(&item.key) {
            if chapter.is_none_or(|id| chapters.contains(&id)) { item.chapter_id = *chapter; }
        }
    }
    items.sort_by_key(|(item, position)| (item.chapter_id.and_then(|id| chapters.iter().position(|chapter| *chapter == id)).unwrap_or(usize::MAX), *position));
    Ok(items.into_iter().map(|(item, _)| item).collect())
}

pub(crate) fn export_titles(connection: &Connection) -> Result<BTreeMap<String, Option<String>>> {
    let episode_id = active_episode_id(connection)?;
    let saved = layout(connection, episode_id)?;
    let mut titles = BTreeMap::new();
    for (key, chapter) in saved.assignments {
        let title = match chapter {
            Some(id) => {
                let title = connection.query_row("SELECT title FROM chapters WHERE id=?1 AND episode_id=?2 AND tombstone=0", params![id, episode_id], |row| row.get::<_, String>(0)).optional()?;
                let Some(title) = title else { continue; };
                Some(title)
            }
            None => None,
        };
        titles.insert(key, title);
    }
    Ok(titles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn fixture() -> (TestDirectory, Connection, i64) {
        let dir = TestDirectory::new();
        let connection = db::open_project(&dir.db_path()).unwrap();
        let episode = active_episode_id(&connection).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('band-test')", []).unwrap();
        for id in [1, 2] {
            connection.execute("INSERT INTO chapters(id,title,start_at,end_at,manual,episode_id) VALUES (?1,?2,'2026-01-01','2026-01-01',1,?3)", params![id, format!("章{id}"), episode]).unwrap();
            connection.execute("INSERT INTO clips(id,volume_uuid,rel_path,tb_num,tb_den,duration_ticks,chapter_id,episode_id,kind) VALUES (?1,'band-test',?2,1,1000,6060,?1,?3,'video')", params![id, format!("{id}.mp4"), episode]).unwrap();
        }
        for id in [11, 12] {
            connection.execute("INSERT INTO segments(id,clip_id,kind,in_ticks,out_ticks) VALUES (?1,1,'select',500,4500)", [id]).unwrap();
        }
        (dir, connection, episode)
    }
    fn entry(segment: i64, chapter: i64) -> BandOrderItem {
        BandOrderItem { item: StoryOrderRef { item_kind: "segment".into(), clip_id: 1, segment_id: Some(segment) }, chapter_id: Some(chapter) }
    }
    #[test]
    fn recalculated_chapters_follow_source_and_preserve_band_order() {
        let (_dir, mut db, episode) = fixture();
        set_order(&mut db, episode, &[entry(12, 1), entry(11, 1)], &[1, 2]).unwrap();
        db.execute_batch("UPDATE clips SET chapter_id=2 WHERE id=1; UPDATE chapters SET tombstone=1 WHERE id=1").unwrap();
        let board = get_storyboard_for(&db, Some(episode)).unwrap();
        assert_eq!(board.items.iter().map(|i| i.chapter_id).collect::<Vec<_>>(), [Some(2), Some(2)]);
        let ordered = ordered_band_items(&db).unwrap();
        assert_eq!(ordered.iter().map(|i| (i.key.as_str(), i.chapter_id)).collect::<Vec<_>>(), [("segment:12", Some(2)), ("segment:11", Some(2))]);
        let titles = export_titles(&db).unwrap();
        for key in ["segment:11", "segment:12"] {
            assert!(titles.get(key).is_none_or(|title| title.as_deref() == Some("章2")));
        }
    }
    #[test]
    fn cross_chapter_override_falls_back_only_when_destination_is_dead() {
        let (_dir, mut db, episode) = fixture();
        set_order(&mut db, episode, &[entry(11, 2)], &[2, 1]).unwrap();
        assert_eq!(get_storyboard_for(&db, Some(episode)).unwrap().items[0].chapter_id, Some(2));
        assert_eq!(ordered_band_items(&db).unwrap()[0].chapter_id, Some(2));
        assert_eq!(export_titles(&db).unwrap()["segment:11"], Some("章2".into()));
        db.execute("UPDATE chapters SET tombstone=1 WHERE id=2", []).unwrap();
        assert_eq!(get_storyboard_for(&db, Some(episode)).unwrap().items[0].chapter_id, Some(1));
        assert_eq!(ordered_band_items(&db).unwrap()[0].chapter_id, Some(1));
        assert!(!export_titles(&db).unwrap().contains_key("segment:11"));
    }
    #[test]
    fn saves_only_deviations_and_compacts_legacy_assignments() {
        let (_dir, mut db, episode) = fixture();
        save_layout(&db, episode, &BandLayout {
            chapter_order: vec![2, 1],
            assignments: BTreeMap::from([("segment:11".into(), Some(1)), ("segment:12".into(), Some(2))]),
        }).unwrap();
        set_order(&mut db, episode, &[entry(11, 1), entry(12, 2)], &[1, 2]).unwrap();
        let saved = layout(&db, episode).unwrap();
        assert_eq!(saved.assignments, BTreeMap::from([("segment:12".into(), Some(2))]));
        assert_eq!(saved.chapter_order, [1, 2]);
        assert_eq!(db.query_row("SELECT chapter_id FROM clips WHERE id=1", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
    #[test]
    fn explicit_unassigned_is_saved_and_read_as_none() {
        let (_dir, mut db, episode) = fixture();
        let mut unassigned = entry(11, 1);
        unassigned.chapter_id = None;
        set_order(&mut db, episode, &[unassigned], &[1, 2]).unwrap();
        assert_eq!(layout(&db, episode).unwrap().assignments.get("segment:11"), Some(&None));
        assert_eq!(get_storyboard_for(&db, Some(episode)).unwrap().items[0].chapter_id, None);
        assert_eq!(ordered_band_items(&db).unwrap()[0].chapter_id, None);
        assert_eq!(export_titles(&db).unwrap().get("segment:11"), Some(&None));
    }
    #[test]
    fn duplicate_inherited_entries_leave_saved_order_unchanged() {
        let (_dir, mut db, episode) = fixture();
        set_order(&mut db, episode, &[entry(12, 1), entry(11, 1)], &[1, 2]).unwrap();
        let saved = serde_json::to_value(layout(&db, episode).unwrap()).unwrap();
        assert!(set_order(&mut db, episode, &[entry(11, 1), entry(11, 1)], &[2, 1]).is_err());
        assert_eq!(serde_json::to_value(layout(&db, episode).unwrap()).unwrap(), saved);
        assert_eq!(ordered_band_items(&db).unwrap().iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), ["segment:12", "segment:11"]);
    }
    #[test]
    fn whole_clip_source_is_normalized_against_live_episode_chapters() {
        let (_dir, mut db, episode) = fixture();
        db.execute_batch("INSERT INTO segments(id,clip_id,kind,in_ticks,out_ticks) VALUES (21,2,'whole',0,6060);
            INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES (21,'binary',1,'2026-01-01')").unwrap();
        let whole = |chapter_id| BandOrderItem {
            item: StoryOrderRef { item_kind: "whole".into(), clip_id: 2, segment_id: None }, chapter_id,
        };
        set_order(&mut db, episode, &[whole(Some(2))], &[2]).unwrap();
        assert!(layout(&db, episode).unwrap().assignments.is_empty());
        db.execute("UPDATE chapters SET tombstone=1 WHERE id=2", []).unwrap();
        set_order(&mut db, episode, &[whole(None)], &[]).unwrap();
        assert!(layout(&db, episode).unwrap().assignments.is_empty());
        db.execute("UPDATE chapters SET tombstone=0, episode_id=NULL WHERE id=2", []).unwrap();
        set_order(&mut db, episode, &[whole(None)], &[]).unwrap();
        assert!(layout(&db, episode).unwrap().assignments.is_empty());
    }
    #[test]
    fn legacy_snapshot_restores_full_assignments_and_dead_overrides_fall_back() {
        let (_dir, mut db, episode) = fixture();
        set_order(&mut db, episode, &[entry(11, 1), entry(12, 2)], &[1, 2]).unwrap();
        let mut snapshot = capture_snapshot(&db, episode).unwrap();
        snapshot.band_layout.assignments = BTreeMap::from([("segment:11".into(), Some(1)), ("segment:12".into(), Some(2))]);
        let json = serde_json::to_string(&snapshot).unwrap();
        let restored: StorySnapshot = serde_json::from_str(&json).unwrap();
        restore_snapshot(&db, episode, &restored).unwrap();
        assert_eq!(get_storyboard_for(&db, Some(episode)).unwrap().items.iter().map(|i| i.chapter_id).collect::<Vec<_>>(), [Some(1), Some(2)]);
        assert_eq!(layout(&db, episode).unwrap().assignments.len(), 2);
        db.execute_batch("UPDATE clips SET chapter_id=2 WHERE id=1; UPDATE chapters SET tombstone=1 WHERE id=1").unwrap();
        assert_eq!(ordered_band_items(&db).unwrap().iter().map(|i| i.chapter_id).collect::<Vec<_>>(), [Some(2), Some(2)]);
        assert_eq!(get_storyboard_for(&db, Some(episode)).unwrap().items.iter().map(|i| i.chapter_id).collect::<Vec<_>>(), [Some(2), Some(2)]);
        assert!(!export_titles(&db).unwrap().contains_key("segment:11"));
        assert_eq!(export_titles(&db).unwrap()["segment:12"], Some("章2".into()));
    }
    #[test]
    fn foreign_episode_override_is_ignored_by_all_readers() {
        let (_dir, mut db, episode) = fixture();
        set_order(&mut db, episode, &[entry(11, 2)], &[1, 2]).unwrap();
        db.execute("UPDATE chapters SET episode_id=NULL WHERE id=2", []).unwrap();
        assert!(!export_titles(&db).unwrap().contains_key("segment:11"));
        assert_eq!(get_storyboard_for(&db, Some(episode)).unwrap().items[0].chapter_id, Some(1));
        assert_eq!(ordered_band_items(&db).unwrap()[0].chapter_id, Some(1));
    }
    #[test]
    fn cross_chapter_is_per_cut_and_export_order_matches_readback() {
        let (_dir, mut db, episode) = fixture();
        set_order(&mut db, episode, &[entry(11, 2), entry(12, 1)], &[2, 1]).unwrap();
        let board = get_storyboard_for(&db, Some(episode)).unwrap();
        assert_eq!(board.chapters.iter().map(|c| c.id).collect::<Vec<_>>(), [2, 1]);
        assert_eq!(board.items.iter().map(|i| i.chapter_id).collect::<Vec<_>>(), [Some(2), Some(1)]);
        assert_eq!(db.query_row("SELECT chapter_id FROM clips WHERE id=1", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        let exported = ordered_band_items(&db).unwrap();
        assert_eq!(exported.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), ["segment:11", "segment:12"]);
        assert_eq!(export_titles(&db).unwrap()["segment:11"], Some("章2".into()));
        set_order(&mut db, episode, &[entry(11, 1), entry(12, 1)], &[1, 2]).unwrap();
        assert!(get_storyboard(&db).unwrap().items.iter().all(|item| item.chapter_id == Some(1)));
    }
    #[test]
    fn wrong_episode_photo_and_invalid_destination_leave_order_unchanged() {
        let (_dir, mut db, episode) = fixture();
        set_order(&mut db, episode, &[entry(11, 1)], &[1, 2]).unwrap();
        assert!(set_order(&mut db, episode + 50, &[entry(11, 2)], &[1, 2]).is_err());
        assert!(set_order(&mut db, episode, &[entry(11, 99)], &[1, 2]).is_err());
        assert!(set_order(&mut db, episode, &[entry(11, 2), entry(11, 1)], &[1, 2]).is_err());
        db.execute("UPDATE clips SET kind='photo' WHERE id=1", []).unwrap();
        assert!(set_order(&mut db, episode, &[entry(11, 2)], &[1, 2]).is_err());
        db.execute("UPDATE clips SET kind='video' WHERE id=1", []).unwrap();
        assert_eq!(get_storyboard_for(&db, Some(episode)).unwrap().items[0].chapter_id, Some(1));
    }
    #[test]
    fn atomic_trim_preserves_id_and_provenance_and_rejects_stale_or_outside_bounds() {
        let (_dir, mut db, episode) = fixture();
        db.execute("UPDATE segments SET source='auto', reason_json='[\"清晰\"]' WHERE id=11", []).unwrap();
        trim(&mut db, episode, 11, [500, 4500], [900, 6060]).unwrap();
        assert!(trim(&mut db, episode, 11, [500, 4500], [1000, 6000]).is_err());
        assert!(trim(&mut db, episode, 11, [900, 6060], [900, 6100]).is_err());
        trim(&mut db, episode, 11, [900, 6060], [500, 4500]).unwrap();
        let saved: (i64, i64, String, String) = db.query_row("SELECT in_ticks,out_ticks,source,reason_json FROM segments WHERE id=11", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(saved, (500, 4500, "auto".into(), "[\"清晰\"]".into()));
    }
}
