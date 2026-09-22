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

pub(super) fn apply_layout(connection: &Connection, episode_id: i64, chapters: &mut [Chapter], items: &mut [StoryItem]) -> Result<()> {
    let saved = layout(connection, episode_id)?;
    chapters.sort_by_key(|chapter| saved.chapter_order.iter().position(|id| *id == chapter.id).unwrap_or(usize::MAX));
    let valid: HashSet<i64> = chapters.iter().map(|chapter| chapter.id).collect();
    for item in items {
        if let Some(chapter) = saved.assignments.get(&item.key) {
            item.chapter_id = chapter.filter(|id| valid.contains(id));
        }
    }
    Ok(())
}

pub fn set_order(connection: &mut Connection, episode_id: i64, order: &[BandOrderItem], chapter_order: &[i64]) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if active_episode_id(&transaction)? != episode_id { return Err(CoreError::Story("当前集已切换".into())); }
    let mut valid = HashSet::new();
    for id in chapter_order.iter().copied().chain(order.iter().filter_map(|item| item.chapter_id)) {
        let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM chapters WHERE id=?1 AND episode_id=?2 AND tombstone=0)", params![id, episode_id], |row| row.get(0))?;
        if !exists { return Err(CoreError::Story("目标章不在当前集".into())); }
        valid.insert(id);
    }
    if chapter_order.iter().copied().collect::<HashSet<_>>().len() != chapter_order.len() { return Err(CoreError::Story("章节顺序重复".into())); }
    let mut assignments = BTreeMap::new();
    for entry in order {
        validate_order_ref(&entry.item)?;
        if !is_video_clip_in_episode(&transaction, entry.item.clip_id, episode_id)? { return Err(CoreError::Story("素材已离线或不在当前集".into())); }
        ensure_selected(&transaction, &entry.item, episode_id)?;
        let key = story_key(&entry.item.item_kind, entry.item.clip_id, entry.item.segment_id);
        if assignments.insert(key, entry.chapter_id).is_some() { return Err(CoreError::Story("镜头顺序重复".into())); }
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
        if let Some(chapter) = saved.assignments.get(&item.key) { item.chapter_id = chapter.filter(|id| chapters.contains(id)); }
    }
    items.sort_by_key(|(item, position)| (item.chapter_id.and_then(|id| chapters.iter().position(|chapter| *chapter == id)).unwrap_or(usize::MAX), *position));
    Ok(items.into_iter().map(|(item, _)| item).collect())
}

pub(crate) fn export_titles(connection: &Connection) -> Result<BTreeMap<String, Option<String>>> {
    let saved = layout(connection, active_episode_id(connection)?)?;
    saved.assignments.iter().map(|(key, chapter)| {
        let title = match chapter {
            Some(id) => connection.query_row("SELECT title FROM chapters WHERE id=?1 AND tombstone=0", [id], |row| row.get(0)).optional()?,
            None => None,
        };
        Ok((key.clone(), title))
    }).collect()
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
        assert_eq!(layout(&db, episode).unwrap().assignments["segment:11"], Some(1));
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
