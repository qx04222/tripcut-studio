//! Persistent single-elimination decisions. A mixed-media tie protects the left
//! member and advances the right: neither is eliminated and ties cannot loop.
use crate::core::{episode, error::{CoreError, Result}};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Member {
    pub clip_id: i64,
    pub segment_id: Option<i64>,
    /// Results-panel photo duels keep the originating auto-select row here.
    /// Photos still use `segment_id = None`, so their duel key remains `photo:*`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_segment_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<crate::core::ratings::SelectSegment>,
}
impl Member {
    fn key(&self) -> String {
        match self.segment_id {
            Some(id) => format!("video:{id}"),
            None => format!("photo:{}", self.clip_id),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: i64,
    pub members: Vec<Member>,
    pub pair: Vec<String>,
    pub winners: Vec<String>,
    pub round: usize,
    pub total: usize,
    pub finished: bool,
    pub undone: bool,
}
#[derive(Default, Serialize, Deserialize)]
struct Snapshot {
    #[serde(default)]
    version: u8,
    primary: Vec<(i64, i64, i64)>,
    segments: Vec<(i64, String)>,
    stacks: Vec<(i64, i64, Option<i64>, String)>,
    created: Vec<i64>,
    #[serde(default)]
    prior_artificial: Vec<i64>,
    #[serde(default)]
    prior_events: Vec<super::similar::PrimaryEvent>,
    #[serde(default)]
    post_segments: Vec<(i64, String)>,
    #[serde(default)]
    post_stacks: Vec<(i64, i64, Option<i64>, String)>,
    #[serde(default)]
    replaced_results: Vec<(i64, Option<String>, Option<String>)>,
    #[serde(default)]
    created_ratings: Vec<(i64, i64)>,
    /// Latest live binary rating row after a results-photo replacement. Undo
    /// must not restore the old result across a later F/X/clear on either clip.
    #[serde(default)]
    post_binary_rating_heads: Vec<(i64, Option<i64>)>,
}
fn fail(text: &str) -> CoreError { CoreError::Rating(text.into()) }
fn json<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|e| fail(&e.to_string()))
}
fn read<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|e| fail(&e.to_string()))
}
fn segment_state(c: &Connection, id: i64) -> Result<Option<String>> {
    c.query_row(
        "SELECT json_array(clip_id,in_ticks,out_ticks,kind,scene_index,tombstone,
                           source,batch_id,reason_json,auto_select_run_id,deleted_at)
         FROM segments WHERE id=?1",
        [id],
        |row| row.get(0),
    ).optional().map_err(Into::into)
}
fn latest_binary_rating_head(c: &Connection, clip_id: i64) -> Result<Option<i64>> {
    c.query_row(
        "SELECT rating.id FROM ratings rating
         JOIN segments segment ON segment.id=rating.segment_id
         WHERE segment.clip_id=?1 AND segment.tombstone=0 AND rating.rating_type='binary'
         ORDER BY rating.id DESC LIMIT 1",
        [clip_id],
        |row| row.get(0),
    ).optional().map_err(Into::into)
}
fn latest_explicit_binary_value(c: &Connection, clip_id: i64) -> Result<Option<i64>> {
    c.query_row(
        "SELECT rating.value FROM ratings rating
         JOIN segments segment ON segment.id=rating.segment_id
         WHERE segment.clip_id=?1 AND segment.tombstone=0 AND COALESCE(segment.kind,'whole')!='select'
           AND rating.rating_type='binary'
         ORDER BY rating.rated_at DESC,rating.id DESC LIMIT 1",
        [clip_id],
        |row| row.get(0),
    ).optional().map_err(Into::into)
}
fn ensure_photo_members_not_explicitly_rejected(c: &Connection, members: &[Member]) -> Result<()> {
    for member in members {
        let kind: String = c.query_row("SELECT kind FROM clips WHERE id=?1", [member.clip_id], |row| row.get(0))?;
        if kind == "photo" && latest_explicit_binary_value(c, member.clip_id)? == Some(-1) {
            return Err(fail("这张照片已明确拒绝；先按 F 保留、清除评级，或换一张再进擂台"));
        }
    }
    Ok(())
}
fn capture_post_state(c: &Connection, snap: &mut Snapshot) -> Result<()> {
    let segment_ids = snap.segments.iter().map(|(id, _)| *id)
        .chain(snap.created.iter().copied())
        .collect::<std::collections::BTreeSet<_>>();
    snap.post_segments.clear();
    for id in segment_ids {
        let state = segment_state(c, id)?
            .ok_or_else(|| fail("擂台写入的片段已不存在"))?;
        snap.post_segments.push((id, state));
    }
    snap.post_stacks.clear();
    for (stack_id, clip_id, segment_id, _) in &snap.stacks {
        let state = c.query_row(
            "SELECT user_state FROM shot_stack_members
             WHERE stack_id=?1 AND clip_id=?2 AND segment_id IS ?3",
            params![stack_id, clip_id, segment_id],
            |row| row.get::<_, String>(0),
        ).optional()?.ok_or_else(|| fail("擂台写入的镜堆成员已不存在"))?;
        snap.post_stacks.push((*stack_id, *clip_id, *segment_id, state));
    }
    Ok(())
}
fn ensure_legacy_no_later_edits(c: &Connection, session: &Session, snap: &Snapshot) -> Result<()> {
    let changed = || fail("这组擂台后来又修改了片段或镜堆，不能撤销旧结果");
    for (segment_id, _) in &snap.segments {
        let member = session.members.iter()
            .find(|member| member.segment_id == Some(*segment_id))
            .ok_or_else(changed)?;
        let expected_kind = if session.winners.contains(&member.key()) { "select" } else { "rejected" };
        let current = c.query_row(
            "SELECT kind,tombstone FROM segments WHERE id=?1",
            [segment_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ).optional()?;
        if current != Some((expected_kind.to_owned(), 0)) {
            return Err(changed());
        }
    }
    for (stack_id, clip_id, segment_id, old_state) in &snap.stacks {
        let member = session.members.iter().find(|member| {
            let stack_segment = if member.segment_id.is_some_and(|id| snap.created.contains(&id)) {
                None
            } else {
                member.segment_id
            };
            member.clip_id == *clip_id && stack_segment == *segment_id
        }).ok_or_else(changed)?;
        let expected = if session.winners.contains(&member.key()) {
            if old_state == "rejected" { "auto" } else { old_state }
        } else {
            "rejected"
        };
        let current = c.query_row(
            "SELECT user_state FROM shot_stack_members
             WHERE stack_id=?1 AND clip_id=?2 AND segment_id IS ?3",
            params![stack_id, clip_id, segment_id],
            |row| row.get::<_, String>(0),
        ).optional()?;
        if current.as_deref() != Some(expected) {
            return Err(changed());
        }
    }
    for segment_id in &snap.created {
        let state = segment_state(c, *segment_id)?.ok_or_else(changed)?;
        let (clip_id, in_ticks, out_ticks, expected_kind) = if let Some(member) = session.members
            .iter().find(|member| member.segment_id == Some(*segment_id))
        {
            let preview = member.preview.as_ref().ok_or_else(changed)?;
            (
                member.clip_id,
                preview.in_ticks,
                preview.out_ticks,
                if session.winners.contains(&member.key()) { "select" } else { "rejected" },
            )
        } else {
            let clip_id = c.query_row(
                "SELECT clip_id FROM segments WHERE id=?1",
                [segment_id],
                |row| row.get::<_, i64>(0),
            )?;
            if !session.winners.contains(&format!("photo:{clip_id}")) {
                return Err(changed());
            }
            (clip_id, 0, 0, "select")
        };
        let expected = serde_json::json!([
            clip_id, in_ticks, out_ticks, expected_kind, null, 0,
            "duel", null, "[]", null, null
        ]).to_string();
        if state != expected {
            return Err(changed());
        }
    }
    Ok(())
}
fn ensure_no_later_edits(c: &Connection, session: &Session, snap: &Snapshot) -> Result<()> {
    if snap.version == 0 && snap.post_segments.is_empty() && snap.post_stacks.is_empty() {
        return ensure_legacy_no_later_edits(c, session, snap);
    }
    let expected_segments = snap.segments.iter().map(|(id, _)| *id)
        .chain(snap.created.iter().copied())
        .collect::<std::collections::BTreeSet<_>>();
    if snap.post_segments.len() != expected_segments.len()
        || snap.post_stacks.len() != snap.stacks.len()
    {
        return Err(fail("这组擂台后来又修改了片段或镜堆，不能撤销旧结果"));
    }
    for (id, expected) in &snap.post_segments {
        if segment_state(c, *id)?.as_ref() != Some(expected) {
            return Err(fail("这组擂台后来又修改了片段或镜堆，不能撤销旧结果"));
        }
    }
    for (stack_id, clip_id, segment_id, expected) in &snap.post_stacks {
        let current = c.query_row(
            "SELECT user_state FROM shot_stack_members
             WHERE stack_id=?1 AND clip_id=?2 AND segment_id IS ?3",
            params![stack_id, clip_id, segment_id],
            |row| row.get::<_, String>(0),
        ).optional()?;
        if current.as_ref() != Some(expected) {
            return Err(fail("这组擂台后来又修改了片段或镜堆，不能撤销旧结果"));
        }
    }
    for (rating_id, clip_id) in &snap.created_ratings {
        let latest = latest_binary_rating_head(c, *clip_id)?;
        if latest != Some(*rating_id) {
            return Err(fail("这组擂台后来又修改了照片评级，不能撤销旧结果"));
        }
    }
    for (clip_id, expected) in &snap.post_binary_rating_heads {
        if latest_binary_rating_head(c, *clip_id)? != *expected {
            return Err(fail("这组擂台后来又修改了照片评级，不能撤销旧结果"));
        }
    }
    Ok(())
}
fn writable(c: &Connection, s: &Session) -> Result<()> {
    if s.undone {
        return Err(fail("这组擂台已撤销"));
    }
    for m in &s.members {
        episode::ensure_clip_writable(c, m.clip_id)?;
    }
    Ok(())
}
fn validate_result_photo_members(c: &Connection, members: &[Member]) -> Result<(i64, i64)> {
    let anchors = members.iter()
        .filter_map(|member| member.result_segment_id.map(|segment_id| (member.clip_id, segment_id)))
        .collect::<Vec<_>>();
    let [(anchor_clip_id, anchor_segment_id)] = anchors.as_slice() else {
        return Err(fail("照片结果擂台必须对应一个结果行"));
    };
    let anchor_group: i64 = c.query_row(
        "SELECT group_id FROM similar_group_members WHERE clip_id=?1",
        [anchor_clip_id],
        |row| row.get(0),
    ).optional()?.ok_or_else(|| fail("照片结果行已不在相似组里"))?;
    let anchor_selections = c.prepare(
        "SELECT id FROM segments WHERE clip_id=?1 AND kind='select' AND tombstone=0 ORDER BY id",
    )?.query_map([anchor_clip_id], |row| row.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if anchor_selections != [*anchor_segment_id] {
        return Err(fail("照片结果行已改变，请重新打开擂台"));
    }
    for member in members {
        let state: Option<(i64, String)> = c.query_row(
            "SELECT member.group_id,clip.kind
             FROM similar_group_members member JOIN clips clip ON clip.id=member.clip_id
             WHERE member.clip_id=?1",
            [member.clip_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if state.as_ref().map(|(group, _)| *group) != Some(anchor_group) {
            return Err(fail("照片结果擂台的候选已不在同一相似组"));
        }
        if state.as_ref().map(|(_, kind)| kind.as_str()) != Some("photo") {
            return Err(fail("照片结果擂台只能包含照片"));
        }
    }
    for member in members.iter().filter(|member| member.clip_id != *anchor_clip_id) {
        let selected: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM segments
             WHERE clip_id=?1 AND kind='select' AND tombstone=0)",
            [member.clip_id],
            |row| row.get(0),
        )?;
        if selected {
            return Err(fail("参赛候选后来已进入精选，请重新打开擂台"));
        }
    }
    Ok((*anchor_clip_id, *anchor_segment_id))
}
pub fn get_session(c: &Connection, id: i64) -> Result<Session> {
    let (raw, finished, undone): (String, bool, bool) =
        c.query_row("SELECT member_ids_json,finished_at IS NOT NULL,undone FROM duel_sessions WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    let members: Vec<Member> = read(&raw)?;
    let mut queue: Vec<String> = members.iter().map(Member::key).collect();
    let mut winners = Vec::new();
    let mut round = 0;
    let mut stmt = c.prepare("SELECT left_id,right_id,winner_id FROM duel_verdicts WHERE session_id=?1 AND undone=0 ORDER BY id")?;
    let rows = stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))?;
    for row in rows {
        let (left, right, win) = row?;
        if queue.len() < 2 || queue[0] != left || queue[1] != right {
            return Err(fail("擂台裁决顺序无效"));
        }
        queue.drain(..2);
        match win {
            Some(key) => queue.insert(0, key),
            None => {
                winners.push(left);
                queue.insert(0, right);
            }
        }
        round += 1;
    }
    let pair = if queue.len() > 1 {
        queue[..2].to_vec()
    } else {
        winners.extend(queue);
        Vec::new()
    };
    let total = members.len() - 1;
    Ok(Session { id, members, total, pair, winners, round, finished, undone })
}
pub fn start_duel(c: &mut Connection, mut members: Vec<Member>, source: &str) -> Result<Session> {
    if members.len() < 2 || members.len() > 200 || !["manual", "results", "similar_group", "shot_stack"].contains(&source) {
        return Err(fail("请选择同一集的 2–200 个成员"));
    }
    for m in &mut members {
        m.preview = None;
    }
    let request = json(&members)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut keys = std::collections::HashSet::new();
    let mut ep = None;
    let mut kinds = std::collections::HashSet::new();
    for m in &members {
        if !keys.insert(m.key()) {
            return Err(fail("擂台成员不能重复"));
        }
        episode::ensure_clip_writable(&tx, m.clip_id)?;
        let (episode_id, kind): (i64, String) =
            tx.query_row("SELECT episode_id,kind FROM clips WHERE id=?1 AND missing_since IS NULL", [m.clip_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        if ep.is_some_and(|e| e != episode_id) {
            return Err(fail("不能跨集比较"));
        }
        ep = Some(episode_id);
        match (kind.as_str(), m.segment_id) {
            ("photo", None) | ("video", None) => {}
            ("video", Some(id)) => {
                let valid: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM segments WHERE id=?1 AND clip_id=?2 AND kind='select' AND tombstone=0)",
                    params![id, m.clip_id],
                    |r| r.get(0),
                )?;
                if !valid {
                    return Err(fail("视频成员必须是有效精选段"));
                }
            }
            _ => return Err(fail("照片用素材、视频用精选段参加擂台")),
        }
        if let Some(segment_id) = m.result_segment_id {
            if source != "results" || kind != "photo" {
                return Err(fail("结果行只用于照片结果擂台"));
            }
            let valid: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM segments WHERE id=?1 AND clip_id=?2 AND kind='select' AND tombstone=0 AND auto_select_run_id IS NOT NULL)",
                params![segment_id, m.clip_id],
                |row| row.get(0),
            )?;
            if !valid {
                return Err(fail("照片结果行已经不在当前挑选结果里"));
            }
        }
        kinds.insert(kind);
    }
    ensure_photo_members_not_explicitly_rejected(&tx, &members)?;
    let has_result_row = members.iter().any(|member| member.result_segment_id.is_some());
    if source == "results" && (has_result_row || kinds.len() == 1 && kinds.contains("photo")) {
        if kinds.len() != 1 || !kinds.contains("photo") {
            return Err(fail("照片结果擂台只能包含照片"));
        }
        validate_result_photo_members(&tx, &members)?;
    }
    let existing: Option<i64> = tx
        .query_row(
            "SELECT id FROM duel_sessions WHERE episode_id=?1 AND request_json=?2 AND source=?3 AND finished_at IS NULL AND undone=0 ORDER BY id DESC LIMIT 1",
            params![ep, request, source],
            |r| r.get(0),
        )
        .optional()?;
    let id = if let Some(id) = existing {
        id
    } else {
        let mut snap = Snapshot::default();
        for m in &mut members {
            let kind: String = tx.query_row("SELECT kind FROM clips WHERE id=?1", [m.clip_id], |r| r.get(0))?;
            if kind == "video" {
                if m.segment_id.is_none() {
                    let duration: i64 = tx.query_row("SELECT duration_ticks FROM clips WHERE id=?1", [m.clip_id], |r| r.get(0))?;
                    let suggested = crate::core::smart_select::suggest_segments(&tx, m.clip_id, Some(6.0))?;
                    let (start, end) = suggested.first().map(|x| (x.in_ticks, x.out_ticks)).unwrap_or((0, duration));
                    if start < 0 || end <= start || end > duration {
                        return Err(fail("视频尚未准备好比较"));
                    }
                    tx.execute(
                        "INSERT INTO segments(clip_id,in_ticks,out_ticks,kind,source) VALUES(?1,?2,?3,'duel_candidate','duel')",
                        params![m.clip_id, start, end],
                    )?;
                    m.segment_id = Some(tx.last_insert_rowid());
                    snap.created.push(tx.last_insert_rowid());
                }
                m.preview = Some(tx.query_row(
                    "SELECT s.id,s.clip_id,s.in_ticks,s.out_ticks,c.tb_num,c.tb_den FROM segments s JOIN clips c ON c.id=s.clip_id WHERE s.id=?1",
                    [m.segment_id],
                    |r| {
                        Ok(crate::core::ratings::SelectSegment {
                            id: r.get(0)?,
                            clip_id: r.get(1)?,
                            in_ticks: r.get(2)?,
                            out_ticks: r.get(3)?,
                            tb_num: r.get(4)?,
                            tb_den: r.get(5)?,
                            source: Some("duel".into()),
                            reasons: Vec::new(),
                        })
                    },
                )?);
            }
        }
        let kind = if kinds.len() > 1 { "mixed" } else { kinds.iter().next().unwrap().as_str() };
        tx.execute("INSERT INTO duel_sessions(episode_id,kind,source,member_ids_json,request_json,snapshot_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![ep,kind,source,json(&members)?,request,json(&snap)?])?;
        tx.last_insert_rowid()
    };
    let s = get_session(&tx, id)?;
    tx.commit()?;
    Ok(s)
}
pub fn decide(c: &mut Connection, id: i64, winner: Option<String>) -> Result<Session> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let s = get_session(&tx, id)?;
    writable(&tx, &s)?;
    if s.finished || s.pair.len() != 2 {
        return Err(fail("这组已经裁定"));
    }
    if let Some(ref win) = winner {
        if !s.pair.contains(win) {
            return Err(fail("赢家必须是当前两者之一"));
        }
    } else if s.pair[0].starts_with("photo:") == s.pair[1].starts_with("photo:") {
        return Err(fail("同类比较请选择一个赢家"));
    }
    tx.execute(
        "INSERT INTO duel_verdicts(session_id,left_id,right_id,winner_id,decided_at) VALUES(?1,?2,?3,?4,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![id, s.pair[0], s.pair[1], winner],
    )?;
    let s = get_session(&tx, id)?;
    tx.commit()?;
    Ok(s)
}
pub fn undo_last(c: &mut Connection, id: i64) -> Result<Session> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let s = get_session(&tx, id)?;
    writable(&tx, &s)?;
    if s.finished {
        return Err(fail("结束后请撤销整组"));
    }
    tx.execute("UPDATE duel_verdicts SET undone=1 WHERE id=(SELECT MAX(id) FROM duel_verdicts WHERE session_id=?1 AND undone=0)", [id])?;
    let s = get_session(&tx, id)?;
    tx.commit()?;
    Ok(s)
}
pub fn finish(c: &mut Connection, id: i64) -> Result<Session> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let s = get_session(&tx, id)?;
    writable(&tx, &s)?;
    if s.finished {
        return Ok(s);
    }
    if !s.pair.is_empty() {
        return Err(fail("还有未裁决的场次"));
    }
    ensure_photo_members_not_explicitly_rejected(&tx, &s.members)?;
    let raw: String = tx.query_row("SELECT snapshot_json FROM duel_sessions WHERE id=?1", [id], |r| r.get(0))?;
    let mut snap: Snapshot = read(&raw)?;
    let (session_kind, session_source): (String, String) = tx.query_row(
        "SELECT kind,source FROM duel_sessions WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if session_source == "results" && (session_kind == "photo" || s.members.iter().any(|member| member.result_segment_id.is_some())) {
        validate_result_photo_members(&tx, &s.members)?;
    }
    let result_photo_anchor = s.members.iter()
        .filter_map(|member| member.result_segment_id.map(|segment_id| (member.clip_id, segment_id)))
        .collect::<Vec<_>>();
    if result_photo_anchor.len() > 1 {
        return Err(fail("照片结果擂台只能有一个结果行"));
    }
    let result_photo_context = if let Some((anchor_clip_id, anchor_segment_id)) = result_photo_anchor.first().copied() {
        let (source, batch_id, reason_json, run_id, deleted_at): (Option<String>, Option<String>, String, Option<String>, Option<String>) = tx.query_row(
            "SELECT source,batch_id,reason_json,auto_select_run_id,deleted_at FROM segments
             WHERE id=?1 AND clip_id=?2 AND kind='select' AND tombstone=0",
            params![anchor_segment_id, anchor_clip_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional()?.ok_or_else(|| fail("照片结果行已经不在当前挑选结果里"))?;
        if run_id.is_none() {
            return Err(fail("照片结果行不属于自动挑选批次"));
        }
        Some((anchor_clip_id, anchor_segment_id, source, batch_id, reason_json, run_id, deleted_at))
    } else {
        None
    };
    for m in &s.members {
        let win = s.winners.contains(&m.key());
        let stack_segment = if m.segment_id.is_some_and(|seg| snap.created.contains(&seg)) { None } else { m.segment_id };
        let mut stmt = tx.prepare(
            "SELECT group_id,clip_id,is_primary FROM similar_group_members WHERE group_id=(SELECT group_id FROM similar_group_members WHERE clip_id=?1)",
        )?;
        for row in stmt.query_map([m.clip_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))? {
            let row = row?;
            if !snap.primary.contains(&row) {
                snap.primary.push(row);
            }
        }
        let mut stmt = tx.prepare("SELECT stack_id,clip_id,segment_id,user_state FROM shot_stack_members WHERE clip_id=?1 AND segment_id IS ?2")?;
        for row in stmt.query_map(params![m.clip_id, stack_segment], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))? {
            snap.stacks.push(row?);
        }
        if let Some(seg) = m.segment_id {
            let kind: String = tx.query_row("SELECT kind FROM segments WHERE id=?1 AND clip_id=?2 AND tombstone=0", params![seg, m.clip_id], |r| r.get(0))?;
            if kind != "select" && !(kind == "duel_candidate" && snap.created.contains(&seg)) {
                return Err(fail("参赛段已改变，请重新开始"));
            }
            snap.segments.push((seg, kind));
            tx.execute("UPDATE segments SET kind=?2 WHERE id=?1", params![seg, if win { "select" } else { "rejected" }])?;
        } else if win && result_photo_context.is_none() {
            let exists: bool =
                tx.query_row("SELECT EXISTS(SELECT 1 FROM segments WHERE clip_id=?1 AND kind='select' AND tombstone=0)", [m.clip_id], |r| r.get(0))?;
            if !exists {
                tx.execute("INSERT INTO segments(clip_id,in_ticks,out_ticks,kind,source) VALUES(?1,0,0,'select','duel')", [m.clip_id])?;
                snap.created.push(tx.last_insert_rowid());
            }
        }
        if !win {
            tx.execute("UPDATE shot_stack_members SET user_state='rejected' WHERE clip_id=?1 AND segment_id IS ?2", params![m.clip_id, stack_segment])?;
        } else {
            tx.execute(
                "UPDATE shot_stack_members SET user_state='auto' WHERE clip_id=?1 AND segment_id IS ?2 AND user_state='rejected'",
                params![m.clip_id, stack_segment],
            )?;
        }
    }
    // A photo duel launched from an auto-select result row is a replacement of
    // that row, not an additional pick. Keep exactly one live selection among
    // the participating group and carry the original batch ledger to its winner.
    if let Some((anchor_clip_id, anchor_segment_id, source, batch_id, reason_json, run_id, deleted_at)) = result_photo_context {
        let winner_clip_id = s.winners.iter().find_map(|key| key.strip_prefix("photo:")?.parse::<i64>().ok())
            .ok_or_else(|| fail("照片结果擂台没有赢家"))?;
        if winner_clip_id != anchor_clip_id {
            snap.segments.push((anchor_segment_id, "select".to_owned()));
            snap.replaced_results.push((anchor_segment_id, batch_id.clone(), deleted_at));
            tx.execute(
                "UPDATE segments SET tombstone=1,batch_id=NULL,deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                [anchor_segment_id],
            )?;
            tx.execute(
                "INSERT INTO segments(clip_id,in_ticks,out_ticks,kind,tombstone,source,batch_id,reason_json,auto_select_run_id)
                 VALUES(?1,0,0,'select',0,?2,?3,?4,?5)",
                params![winner_clip_id, source, batch_id, reason_json, run_id],
            )?;
            let winner_segment_id = tx.last_insert_rowid();
            snap.created.push(winner_segment_id);
            tx.execute(
                "INSERT INTO ratings(segment_id,rating_type,value,rated_at)
                 VALUES(?1,'binary',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                [winner_segment_id],
            )?;
            snap.created_ratings.push((tx.last_insert_rowid(), winner_clip_id));
            for clip_id in [anchor_clip_id, winner_clip_id] {
                snap.post_binary_rating_heads.push((clip_id, latest_binary_rating_head(&tx, clip_id)?));
            }
        }
    }
    // Capture which old primaries came from an artificial decision. If a
    // same-winner duel supersedes that identity, undo must restore the source
    // decision rather than turning it into an automatic primary.
    for (group_id, clip_id, primary) in &snap.primary {
        if *primary == 1 {
            let prior = super::similar::latest_primary_event_in_group(&tx, *group_id)?;
            if prior.as_ref().is_some_and(|event| event.clip_id == *clip_id) {
                if !snap.prior_artificial.contains(clip_id) {
                    snap.prior_artificial.push(*clip_id);
                }
                if !snap.prior_events.iter().any(|event| event.clip_id == *clip_id) {
                    snap.prior_events.push(prior.expect("checked prior primary event"));
                }
            }
        }
    }
    // Capture all old primaries before changing any, including non-participants.
    for m in &s.members {
        if s.winners.contains(&m.key()) && m.segment_id.is_none() {
            tx.execute(
                "UPDATE similar_group_members SET is_primary=0 WHERE group_id=(SELECT group_id FROM similar_group_members WHERE clip_id=?1)",
                [m.clip_id],
            )?;
            tx.execute("UPDATE similar_group_members SET is_primary=1 WHERE clip_id=?1", [m.clip_id])?;
            super::similar::record_duel_primary(&tx, m.clip_id, id)?;
        }
    }
    snap.version = 1;
    capture_post_state(&tx, &mut snap)?;
    tx.execute(
        "UPDATE duel_sessions SET finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),winner_clip_or_segment_id=?2,snapshot_json=?3 WHERE id=?1",
        params![id, s.winners.first(), json(&snap)?],
    )?;
    let s = get_session(&tx, id)?;
    tx.commit()?;
    Ok(s)
}
pub fn undo_session(c: &mut Connection, id: i64) -> Result<Session> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let s = get_session(&tx, id)?;
    if s.undone {
        return Ok(s);
    }
    writable(&tx, &s)?;
    {
        let raw: String = tx.query_row("SELECT snapshot_json FROM duel_sessions WHERE id=?1", [id], |r| r.get(0))?;
        let snap: Snapshot = read(&raw)?;
        ensure_no_later_edits(&tx, &s, &snap)?;
        super::similar::invalidate_duel_primary(&tx, id)?;
        let mut affected_groups = std::collections::BTreeSet::<i64>::new();
        for (_, clip, _) in &snap.primary {
            if let Some(group_id) = tx.query_row(
                "SELECT group_id FROM similar_group_members WHERE clip_id=?1",
                [clip],
                |row| row.get::<_, i64>(0),
            ).optional()? {
                affected_groups.insert(group_id);
            }
        }
        let mut restored_primaries = std::collections::BTreeMap::<i64, i64>::new();
        for (_, clip, primary) in &snap.primary {
            if *primary == 0 {
                continue;
            }
            let current_group = tx.query_row(
                "SELECT group_id FROM similar_group_members WHERE clip_id=?1",
                [*clip],
                |row| row.get::<_, i64>(0),
            ).optional()?;
            if let Some(group_id) = current_group {
                restored_primaries.entry(group_id)
                    .and_modify(|current| *current = (*current).min(*clip))
                    .or_insert(*clip);
            }
        }
        for group_id in affected_groups {
            let (clip_id, restored_snapshot) = match super::similar::latest_primary_in_group(&tx, group_id)? {
                Some(clip_id) => (clip_id, false),
                None => match restored_primaries.get(&group_id) {
                    Some(clip_id) => (*clip_id, true),
                    None => continue,
                },
            };
            tx.execute("UPDATE similar_group_members SET is_primary=0 WHERE group_id=?1", [group_id])?;
            tx.execute(
                "UPDATE similar_group_members SET is_primary=1 WHERE group_id=?1 AND clip_id=?2",
                params![group_id, clip_id],
            )?;
            if restored_snapshot {
                if let Some(prior) = snap.prior_events.iter()
                    .find(|event| event.clip_id == clip_id)
                {
                    super::similar::restore_primary_event(&tx, prior)?;
                } else if snap.prior_artificial.contains(&clip_id) {
                    super::similar::record_restored_primary(&tx, clip_id)?;
                }
            }
        }
        for (seg, kind) in snap.segments {
            tx.execute("UPDATE segments SET kind=?2 WHERE id=?1", params![seg, kind])?;
        }
        for (seg, batch_id, deleted_at) in snap.replaced_results {
            tx.execute(
                "UPDATE segments SET tombstone=0,batch_id=?2,deleted_at=?3 WHERE id=?1",
                params![seg, batch_id, deleted_at],
            )?;
        }
        for (stack, clip, seg, state) in snap.stacks {
            tx.execute("UPDATE shot_stack_members SET user_state=?4 WHERE stack_id=?1 AND clip_id=?2 AND segment_id IS ?3", params![stack, clip, seg, state])?;
        }
        for (rating_id, _) in snap.created_ratings {
            tx.execute("DELETE FROM ratings WHERE id=?1", [rating_id])?;
        }
        for seg in snap.created {
            tx.execute("UPDATE segments SET tombstone=1,deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [seg])?;
        }
    }
    tx.execute("UPDATE duel_verdicts SET undone=1 WHERE session_id=?1", [id])?;
    tx.execute("UPDATE duel_sessions SET undone=1 WHERE id=?1", [id])?;
    let s = get_session(&tx, id)?;
    tx.commit()?;
    Ok(s)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        for m in crate::core::migrations::MIGRATIONS {
            c.execute_batch(m.sql).unwrap();
        }
        for id in 1..=7 {
            c.execute(
                "INSERT INTO clips(id,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks)
                 VALUES(?1,?2,?3,'photo',1,1,1000,0)",
                params![id, format!("{id}.jpg"), format!("hash-{id}")],
            ).unwrap();
            c.execute("INSERT INTO photo_meta(clip_id) VALUES(?1)", [id]).unwrap();
        }
        c.execute("INSERT INTO similar_groups(id,created_at) VALUES(1,'now')", []).unwrap();
        for id in 1..=7 {
            c.execute("INSERT INTO similar_group_members VALUES(1,?1,?2)", rusqlite::params![id, i64::from(id == 1)]).unwrap();
        }
        c
    }
    fn members(n: i64) -> Vec<Member> { (1..=n).map(|id| Member { clip_id: id, segment_id: None, result_segment_id: None, preview: None }).collect() }
    fn result_photo_db(run_id: &str) -> Connection {
        let c = db();
        c.execute(
            "INSERT INTO auto_select_runs(run_id,episode_id,params_json,created_at) VALUES(?1,1,'{}','now')",
            [run_id],
        ).unwrap();
        c.execute(
            "INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source,batch_id,reason_json,auto_select_run_id)
             VALUES(101,1,0,0,'select','auto',?1,'[]',?1)",
            [run_id],
        ).unwrap();
        c
    }
    fn result_photo_members() -> Vec<Member> {
        vec![
            Member { clip_id: 1, segment_id: None, result_segment_id: Some(101), preview: None },
            Member { clip_id: 2, segment_id: None, result_segment_id: None, preview: None },
        ]
    }
    fn finish_with_photo_winner(c: &mut Connection, target: i64) -> Session {
        let mut session = start_duel(c, members(3), "similar_group").unwrap();
        while !session.pair.is_empty() {
            let target_key = format!("photo:{target}");
            let winner = if session.pair.contains(&target_key) {
                target_key
            } else {
                session.pair[0].clone()
            };
            session = decide(c, session.id, Some(winner)).unwrap();
        }
        finish(c, session.id).unwrap()
    }
    fn finish_video_duel(c: &mut Connection) -> Session {
        c.execute("UPDATE clips SET kind='video',duration_ticks=9000 WHERE id IN (2,3)", []).unwrap();
        c.execute(
            "INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind) VALUES
             (22,2,10,2000,'select'),(33,3,20,3000,'select')",
            [],
        ).unwrap();
        let duel = start_duel(c, vec![
            Member { clip_id: 2, segment_id: Some(22), result_segment_id: None, preview: None },
            Member { clip_id: 3, segment_id: Some(33), result_segment_id: None, preview: None },
        ], "manual").unwrap();
        let duel = decide(c, duel.id, Some("video:22".to_owned())).unwrap();
        finish(c, duel.id).unwrap()
    }
    fn downgrade_snapshot_to_legacy(c: &Connection, session_id: i64) {
        let raw: String = c.query_row(
            "SELECT snapshot_json FROM duel_sessions WHERE id=?1",
            [session_id],
            |row| row.get(0),
        ).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("version");
        object.remove("post_segments");
        object.remove("post_stacks");
        c.execute(
            "UPDATE duel_sessions SET snapshot_json=?2 WHERE id=?1",
            params![session_id, value.to_string()],
        ).unwrap();
    }
    #[test]
    fn duel_seven_six_decisions_and_full_rollback() {
        let mut c = db();
        let mut s = start_duel(&mut c, members(7), "similar_group").unwrap();
        for _ in 0..6 {
            let win = s.pair[1].clone();
            s = decide(&mut c, s.id, Some(win)).unwrap();
        }
        assert_eq!(s.round, 6); assert!(s.pair.is_empty());
        s = finish(&mut c, s.id).unwrap();
        assert_eq!(s.winners.len(), 1);
        assert_eq!(c.query_row("SELECT clip_id FROM similar_group_members WHERE is_primary=1", [], |r| r.get::<_, i64>(0)).unwrap(), 7);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM segments WHERE kind='select' AND in_ticks=0 AND out_ticks=0", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        undo_session(&mut c, s.id).unwrap();
        assert_eq!(c.query_row("SELECT clip_id FROM similar_group_members WHERE is_primary=1", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM duel_verdicts WHERE undone=1", [], |r| r.get::<_, i64>(0)).unwrap(), 6);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM segments WHERE tombstone=0", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn results_photo_duel_replaces_the_auto_selected_row_and_undo_restores_its_ledger() {
        let mut c = db();
        c.execute(
            "INSERT INTO auto_select_runs(run_id,episode_id,params_json,created_at) VALUES('run-photo',1,'{}','now')",
            [],
        ).unwrap();
        c.execute(
            "INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source,batch_id,reason_json,auto_select_run_id)
             VALUES(101,1,0,0,'select','auto','run-photo','[\"清晰\"]','run-photo')",
            [],
        ).unwrap();
        c.execute("INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES(101,'binary',1,'now')", []).unwrap();
        let members = vec![
            Member { clip_id: 1, segment_id: None, result_segment_id: Some(101), preview: None },
            Member { clip_id: 2, segment_id: None, result_segment_id: None, preview: None },
        ];
        let session = start_duel(&mut c, members, "results").unwrap();
        let session = decide(&mut c, session.id, Some("photo:2".to_owned())).unwrap();
        finish(&mut c, session.id).unwrap();

        assert_eq!(c.query_row(
            "SELECT COUNT(*) FROM segments s JOIN similar_group_members gm ON gm.clip_id=s.clip_id
             WHERE gm.group_id=1 AND s.kind='select' AND s.tombstone=0",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1, "同组只能留一条 live select");
        assert_eq!(c.query_row(
            "SELECT clip_id FROM segments WHERE kind='select' AND tombstone=0",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 2, "B 胜后只有 B 进入精选和交付集合");
        assert_eq!(c.query_row(
            "SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 2, "B 同时成为组主图");
        assert_eq!(c.query_row(
            "SELECT COUNT(*) FROM segments WHERE clip_id=2 AND auto_select_run_id='run-photo' AND batch_id='run-photo' AND kind='select' AND tombstone=0",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1, "B 留在原自动挑选批次账本");
        let run = crate::core::smart_select_runs::list_run(&c, "run-photo").unwrap();
        assert_eq!(run.rows.len(), 1);
        assert_eq!(run.rows[0].clip_id, 2, "结果面板同一批只显示 B");
        assert!(run.rows[0].reasons.iter().any(|reason| reason == "清晰"), "B 继承结果行理由");
        c.execute("UPDATE photo_meta SET width=100,height=100,orientation=1,hold_ms=3000,has_alpha=0,companions_ambiguous=0", []).unwrap();
        let listed = crate::core::import::list_clips(&c).unwrap();
        let a = listed.iter().find(|clip| clip.id == Some(1)).unwrap();
        let b = listed.iter().find(|clip| clip.id == Some(2)).unwrap();
        assert_eq!((a.binary_rating, a.select_count), (None, 0), "A 的旧自动精选和其 binary=1 一起从活读取链消失");
        assert_eq!((b.binary_rating, b.select_count), (Some(1), 1), "B 成为精选且有 binary=1");
        c.execute("INSERT INTO volumes(uuid,label) VALUES('test-volume','test')", []).unwrap();
        c.execute("UPDATE clips SET volume_uuid='test-volume' WHERE episode_id=1", []).unwrap();
        let delivered = crate::core::deliver::selected_clips(&c).unwrap();
        assert_eq!(delivered.iter().filter(|clip| clip.media_kind == "photo").map(|clip| clip.clip_id).collect::<Vec<_>>(), vec![2]);

        drop(c);
        let path = std::env::temp_dir().join(format!(
            "tripcut-results-photo-duel-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        ));
        let mut disk = rusqlite::Connection::open(&path).unwrap();
        for migration in crate::core::migrations::MIGRATIONS { disk.execute_batch(migration.sql).unwrap(); }
        for id in 1..=2 {
            disk.execute(
                "INSERT INTO clips(id,rel_path,quick_hash,kind,episode_id,tb_num,tb_den,duration_ticks) VALUES(?1,?2,?3,'photo',1,1,1000,0)",
                params![id, format!("{id}.jpg"), format!("disk-hash-{id}")],
            ).unwrap();
            disk.execute("INSERT INTO photo_meta(clip_id) VALUES(?1)", [id]).unwrap();
        }
        disk.execute("INSERT INTO similar_groups(id,created_at) VALUES(1,'now')", []).unwrap();
        disk.execute("INSERT INTO similar_group_members VALUES(1,1,1),(1,2,0)", []).unwrap();
        disk.execute("INSERT INTO auto_select_runs(run_id,episode_id,params_json,created_at) VALUES('run-photo',1,'{}','now')", []).unwrap();
        disk.execute("INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source,batch_id,reason_json,auto_select_run_id) VALUES(101,1,0,0,'select','auto','run-photo','[]','run-photo')", []).unwrap();
        disk.execute("INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES(101,'binary',1,'now')", []).unwrap();
        let disk_session = start_duel(&mut disk, vec![
            Member { clip_id: 1, segment_id: None, result_segment_id: Some(101), preview: None },
            Member { clip_id: 2, segment_id: None, result_segment_id: None, preview: None },
        ], "results").unwrap();
        let disk_session = decide(&mut disk, disk_session.id, Some("photo:2".to_owned())).unwrap();
        let disk_session = finish(&mut disk, disk_session.id).unwrap();
        drop(disk);
        let mut disk = rusqlite::Connection::open(&path).unwrap();
        undo_session(&mut disk, disk_session.id).unwrap();
        assert_eq!(disk.query_row(
            "SELECT group_concat(state, ',') FROM (
                 SELECT id || ':' || kind || ':' || tombstone || ':' || coalesce(auto_select_run_id,'') AS state
                 FROM segments ORDER BY id
             )",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(), "101:select:0:run-photo,102:select:1:run-photo");
        assert_eq!(disk.query_row(
            "SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1);
        assert_eq!(disk.query_row(
            "SELECT COUNT(*) FROM ratings rating JOIN segments segment ON segment.id=rating.segment_id
             WHERE segment.clip_id=1 AND segment.tombstone=0 AND rating.rating_type='binary' AND rating.value=1",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1, "撤销重新露出 A 原有 binary=1");
        assert_eq!(disk.query_row(
            "SELECT COUNT(*) FROM ratings rating JOIN segments segment ON segment.id=rating.segment_id
             WHERE segment.clip_id=2 AND segment.tombstone=0 AND rating.rating_type='binary'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 0, "撤销删除擂台给 B 写的 binary=1");
        assert_eq!(disk.query_row(
            "SELECT COUNT(*) FROM duel_verdicts WHERE session_id=?1 AND undone=1",
            [disk_session.id],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1);
        drop(disk);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn results_photo_duel_keeps_the_original_row_when_it_wins() {
        let mut c = db();
        c.execute("INSERT INTO auto_select_runs(run_id,episode_id,params_json,created_at) VALUES('run-a',1,'{}','now')", []).unwrap();
        c.execute(
            "INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source,batch_id,reason_json,auto_select_run_id)
             VALUES(101,1,0,0,'select','auto','batch-a','[\"原理由\"]','run-a')",
            [],
        ).unwrap();
        let session = start_duel(&mut c, vec![
            Member { clip_id: 1, segment_id: None, result_segment_id: Some(101), preview: None },
            Member { clip_id: 2, segment_id: None, result_segment_id: None, preview: None },
        ], "results").unwrap();
        let session = decide(&mut c, session.id, Some("photo:1".to_owned())).unwrap();
        let session = finish(&mut c, session.id).unwrap();
        let state: (i64, i64, String, String, String, String, String) = c.query_row(
            "SELECT id,clip_id,kind,source,batch_id,reason_json,auto_select_run_id FROM segments WHERE tombstone=0",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
        ).unwrap();
        assert_eq!(state, (101, 1, "select".into(), "auto".into(), "batch-a".into(), "[\"原理由\"]".into(), "run-a".into()));
        undo_session(&mut c, session.id).unwrap();
        let restored: (i64, i64, String, String, String, String, String) = c.query_row(
            "SELECT id,clip_id,kind,source,batch_id,reason_json,auto_select_run_id FROM segments WHERE tombstone=0",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
        ).unwrap();
        assert_eq!(restored, state, "整组撤销保持原 segment id 与账本元数据");
        assert_eq!(c.query_row("SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn results_photo_duel_finish_rolls_back_atomically_when_winner_insert_fails() {
        let mut c = db();
        c.execute("INSERT INTO auto_select_runs(run_id,episode_id,params_json,created_at) VALUES('run-fail',1,'{}','now')", []).unwrap();
        c.execute(
            "INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source,batch_id,reason_json,auto_select_run_id)
             VALUES(101,1,0,0,'select','auto','run-fail','[]','run-fail')",
            [],
        ).unwrap();
        let session = start_duel(&mut c, vec![
            Member { clip_id: 1, segment_id: None, result_segment_id: Some(101), preview: None },
            Member { clip_id: 2, segment_id: None, result_segment_id: None, preview: None },
        ], "results").unwrap();
        let session = decide(&mut c, session.id, Some("photo:2".to_owned())).unwrap();
        c.execute_batch("CREATE TRIGGER fail_result_photo_rating BEFORE INSERT ON ratings BEGIN SELECT RAISE(ABORT,'boom'); END;").unwrap();
        assert!(finish(&mut c, session.id).is_err());
        assert_eq!(c.query_row("SELECT clip_id FROM segments WHERE kind='select' AND tombstone=0", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(c.query_row("SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert!(!c.query_row("SELECT finished_at IS NOT NULL FROM duel_sessions WHERE id=?1", [session.id], |row| row.get::<_, bool>(0)).unwrap());
        assert_eq!(c.query_row("SELECT COUNT(*) FROM duel_verdicts WHERE session_id=?1 AND undone=0", [session.id], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM ratings", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn results_photo_duel_requires_exactly_one_result_row_at_start() {
        let mut c = db();
        c.execute("INSERT INTO auto_select_runs(run_id,episode_id,params_json,created_at) VALUES('run-input',1,'{}','now')", []).unwrap();
        c.execute(
            "INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source,batch_id,reason_json,auto_select_run_id) VALUES
             (101,1,0,0,'select','auto','run-input','[]','run-input'),
             (102,2,0,0,'select','auto','run-input','[]','run-input')",
            [],
        ).unwrap();
        assert!(start_duel(&mut c, vec![
            Member { clip_id: 1, segment_id: None, result_segment_id: None, preview: None },
            Member { clip_id: 2, segment_id: None, result_segment_id: None, preview: None },
        ], "results").is_err());
        assert!(start_duel(&mut c, vec![
            Member { clip_id: 1, segment_id: None, result_segment_id: Some(101), preview: None },
            Member { clip_id: 2, segment_id: None, result_segment_id: Some(102), preview: None },
        ], "results").is_err());
        assert_eq!(c.query_row("SELECT COUNT(*) FROM duel_sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn photo_duel_rejects_an_explicitly_rejected_anchor_or_candidate_at_start() {
        for rejected_clip_id in [1, 2] {
            let mut c = result_photo_db(&format!("run-start-x-{rejected_clip_id}"));
            crate::core::ratings::rate_clip(&mut c, rejected_clip_id, "binary", -1).unwrap();
            let error = start_duel(&mut c, result_photo_members(), "results").unwrap_err().to_string();
            assert!(error.contains("先按 F 保留、清除评级，或换一张"), "{error}");
            assert_eq!(c.query_row("SELECT COUNT(*) FROM duel_sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            assert_eq!(c.query_row("SELECT COUNT(*) FROM duel_verdicts", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        }
        let mut backfilled = result_photo_db("run-start-x-backfill");
        crate::core::ratings::rate_clip(&mut backfilled, 2, "binary", -1).unwrap();
        let whole_id = backfilled.query_row(
            "SELECT id FROM segments WHERE clip_id=2 AND kind='whole'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap();
        backfilled.execute(
            "INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES(?1,'binary',1,'2000-01-01T00:00:00Z')",
            [whole_id],
        ).unwrap();
        assert!(start_duel(&mut backfilled, result_photo_members(), "results").is_err(), "回填的旧评级不能凭较大 id 覆盖较新的 X");
        assert_eq!(backfilled.query_row("SELECT COUNT(*) FROM duel_sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn photo_duel_allows_a_later_f_or_clear_and_ignores_select_segment_ratings() {
        for recovered_value in [0, 1] {
            let mut c = result_photo_db(&format!("run-recovered-{recovered_value}"));
            crate::core::ratings::rate_clip(&mut c, 2, "binary", -1).unwrap();
            crate::core::ratings::rate_clip(&mut c, 2, "binary", recovered_value).unwrap();
            let session = start_duel(&mut c, result_photo_members(), "results").unwrap();
            assert_eq!(session.members.len(), 2);
        }
        let mut c = result_photo_db("run-select-rating");
        c.execute("INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES(101,'binary',-1,'2099-01-01T00:00:00Z')", []).unwrap();
        let session = start_duel(&mut c, result_photo_members(), "results").unwrap();
        assert_eq!(session.members.len(), 2, "select 段上的自动账本评级不等于用户显式 X");
    }

    #[test]
    fn photo_duel_finish_rejects_a_later_explicit_x_without_partial_writes() {
        let mut c = result_photo_db("run-finish-x");
        let session = start_duel(&mut c, result_photo_members(), "results").unwrap();
        let session = decide(&mut c, session.id, Some("photo:2".to_owned())).unwrap();
        crate::core::ratings::rate_clip(&mut c, 2, "binary", -1).unwrap();
        let segments_before = c.query_row(
            "SELECT group_concat(id || ':' || clip_id || ':' || kind || ':' || tombstone, ',') FROM (SELECT id,clip_id,kind,tombstone FROM segments ORDER BY id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap();
        let ratings_before = c.query_row(
            "SELECT group_concat(id || ':' || value, ',') FROM (SELECT id,value FROM ratings ORDER BY id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap();
        let error = finish(&mut c, session.id).unwrap_err().to_string();
        assert!(error.contains("先按 F 保留、清除评级，或换一张"), "{error}");
        assert_eq!(c.query_row(
            "SELECT group_concat(id || ':' || clip_id || ':' || kind || ':' || tombstone, ',') FROM (SELECT id,clip_id,kind,tombstone FROM segments ORDER BY id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(), segments_before);
        assert_eq!(c.query_row(
            "SELECT group_concat(id || ':' || value, ',') FROM (SELECT id,value FROM ratings ORDER BY id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(), ratings_before);
        assert_eq!(c.query_row("SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert!(!get_session(&c, session.id).unwrap().finished);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM duel_verdicts WHERE session_id=?1 AND undone=0", [session.id], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn results_photo_duel_validates_participants_and_preserves_an_unrelated_selected_group_member() {
        let mut cross_group = result_photo_db("run-cross");
        cross_group.execute("INSERT INTO similar_groups(id,created_at) VALUES(2,'now')", []).unwrap();
        cross_group.execute("UPDATE similar_group_members SET group_id=2,is_primary=1 WHERE clip_id=2", []).unwrap();
        assert!(start_duel(&mut cross_group, result_photo_members(), "results").is_err());
        assert_eq!(cross_group.query_row("SELECT COUNT(*) FROM duel_sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(cross_group.query_row("SELECT kind FROM segments WHERE id=101", [], |row| row.get::<_, String>(0)).unwrap(), "select");
        assert_eq!(cross_group.query_row("SELECT group_concat(group_id || ':' || clip_id || ':' || is_primary, ',') FROM (SELECT * FROM similar_group_members WHERE clip_id IN (1,2) ORDER BY clip_id)", [], |row| row.get::<_, String>(0)).unwrap(), "1:1:1,2:2:1");

        let mut selected_member = result_photo_db("run-selected");
        selected_member.execute("INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source) VALUES(102,2,0,0,'select','manual')", []).unwrap();
        assert!(start_duel(&mut selected_member, result_photo_members(), "results").is_err());
        assert_eq!(selected_member.query_row("SELECT COUNT(*) FROM duel_sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(selected_member.query_row("SELECT group_concat(id || ':' || clip_id || ':' || kind, ',') FROM (SELECT id,clip_id,kind FROM segments ORDER BY id)", [], |row| row.get::<_, String>(0)).unwrap(), "101:1:select,102:2:select");
        assert_eq!(selected_member.query_row("SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1", [], |row| row.get::<_, i64>(0)).unwrap(), 1);

        let mut hidden_selected = result_photo_db("run-hidden");
        hidden_selected.execute("INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source) VALUES(103,3,0,0,'select','manual')", []).unwrap();
        let session = start_duel(&mut hidden_selected, result_photo_members(), "results").unwrap();
        let session = decide(&mut hidden_selected, session.id, Some("photo:2".to_owned())).unwrap();
        let session = finish(&mut hidden_selected, session.id).unwrap();
        assert_eq!(hidden_selected.query_row(
            "SELECT group_concat(clip_id, ',') FROM (SELECT clip_id FROM segments WHERE kind='select' AND tombstone=0 ORDER BY clip_id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(), "2,3", "未参赛 C 的独立精选保持不变");
        undo_session(&mut hidden_selected, session.id).unwrap();
        assert_eq!(hidden_selected.query_row(
            "SELECT group_concat(clip_id, ',') FROM (SELECT clip_id FROM segments WHERE kind='select' AND tombstone=0 ORDER BY clip_id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(), "1,3", "撤销只恢复参赛结果行 A，仍保留 C");

        let mut duplicate_anchor = result_photo_db("run-anchor-duplicate");
        duplicate_anchor.execute("INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source) VALUES(104,1,0,0,'select','manual')", []).unwrap();
        assert!(start_duel(&mut duplicate_anchor, result_photo_members(), "results").is_err());
        assert_eq!(duplicate_anchor.query_row("SELECT COUNT(*) FROM duel_sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(duplicate_anchor.query_row("SELECT COUNT(*) FROM segments WHERE clip_id=1 AND kind='select' AND tombstone=0", [], |row| row.get::<_, i64>(0)).unwrap(), 2);

        let mut mixed = result_photo_db("run-mixed");
        mixed.execute("UPDATE clips SET kind='video',duration_ticks=9000 WHERE id=2", []).unwrap();
        assert!(start_duel(&mut mixed, result_photo_members(), "results").is_err());
        assert_eq!(mixed.query_row("SELECT COUNT(*) FROM duel_sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn results_photo_duel_revalidates_group_and_live_selection_drift_before_finish() {
        for drift in ["group", "selection", "anchor-selection"] {
            let mut c = result_photo_db(&format!("run-{drift}"));
            let session = start_duel(&mut c, result_photo_members(), "results").unwrap();
            let session = decide(&mut c, session.id, Some("photo:2".to_owned())).unwrap();
            if drift == "group" {
                c.execute("INSERT INTO similar_groups(id,created_at) VALUES(2,'now')", []).unwrap();
                c.execute("UPDATE similar_group_members SET group_id=2,is_primary=1 WHERE clip_id=2", []).unwrap();
            } else if drift == "selection" {
                c.execute("INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source) VALUES(102,2,0,0,'select','manual')", []).unwrap();
            } else {
                c.execute("INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,source) VALUES(104,1,0,0,'select','manual')", []).unwrap();
            }
            let segments_before = c.query_row(
                "SELECT group_concat(id || ':' || clip_id || ':' || kind || ':' || tombstone, ',') FROM (SELECT id,clip_id,kind,tombstone FROM segments ORDER BY id)",
                [],
                |row| row.get::<_, String>(0),
            ).unwrap();
            let groups_before = c.query_row(
                "SELECT group_concat(group_id || ':' || clip_id || ':' || is_primary, ',') FROM (SELECT * FROM similar_group_members WHERE clip_id IN (1,2) ORDER BY clip_id)",
                [],
                |row| row.get::<_, String>(0),
            ).unwrap();
            assert!(finish(&mut c, session.id).is_err(), "{drift}");
            assert_eq!(c.query_row(
                "SELECT group_concat(id || ':' || clip_id || ':' || kind || ':' || tombstone, ',') FROM (SELECT id,clip_id,kind,tombstone FROM segments ORDER BY id)",
                [],
                |row| row.get::<_, String>(0),
            ).unwrap(), segments_before, "{drift}: finish 失败不能改任何精选");
            assert_eq!(c.query_row(
                "SELECT group_concat(group_id || ':' || clip_id || ':' || is_primary, ',') FROM (SELECT * FROM similar_group_members WHERE clip_id IN (1,2) ORDER BY clip_id)",
                [],
                |row| row.get::<_, String>(0),
            ).unwrap(), groups_before, "{drift}: finish 失败不能改主图");
            assert!(!c.query_row("SELECT finished_at IS NOT NULL FROM duel_sessions WHERE id=?1", [session.id], |row| row.get::<_, bool>(0)).unwrap());
            assert_eq!(c.query_row("SELECT COUNT(*) FROM duel_verdicts WHERE session_id=?1 AND undone=0", [session.id], |row| row.get::<_, i64>(0)).unwrap(), 1);
        }
    }

    #[test]
    fn results_photo_duel_undo_refuses_a_later_winner_rating_without_partial_restore() {
        let mut c = result_photo_db("run-later-rating");
        let session = start_duel(&mut c, result_photo_members(), "results").unwrap();
        let session = decide(&mut c, session.id, Some("photo:2".to_owned())).unwrap();
        let session = finish(&mut c, session.id).unwrap();
        crate::core::ratings::rate_clip(&mut c, 2, "binary", -1).unwrap();
        let segments_before = c.query_row(
            "SELECT group_concat(id || ':' || clip_id || ':' || kind || ':' || tombstone, ',') FROM (SELECT id,clip_id,kind,tombstone FROM segments ORDER BY id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap();
        let ratings_before = c.query_row(
            "SELECT group_concat(id || ':' || value, ',') FROM (SELECT id,value FROM ratings ORDER BY id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap();
        assert!(undo_session(&mut c, session.id).is_err());
        assert_eq!(c.query_row(
            "SELECT group_concat(id || ':' || clip_id || ':' || kind || ':' || tombstone, ',') FROM (SELECT id,clip_id,kind,tombstone FROM segments ORDER BY id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(), segments_before);
        assert_eq!(c.query_row(
            "SELECT group_concat(id || ':' || value, ',') FROM (SELECT id,value FROM ratings ORDER BY id)",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(), ratings_before);
        assert!(!get_session(&c, session.id).unwrap().undone);
        assert_eq!(c.query_row("SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn results_photo_duel_undo_refuses_a_later_anchor_rating_without_partial_restore() {
        let mut c = result_photo_db("run-later-anchor-rating");
        c.execute("INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES(101,'binary',1,'auto')", []).unwrap();
        let session = start_duel(&mut c, result_photo_members(), "results").unwrap();
        let session = decide(&mut c, session.id, Some("photo:2".to_owned())).unwrap();
        let session = finish(&mut c, session.id).unwrap();
        crate::core::ratings::rate_clip(&mut c, 1, "binary", -1).unwrap();
        assert!(undo_session(&mut c, session.id).is_err());
        c.execute("UPDATE photo_meta SET width=100,height=100,orientation=1,hold_ms=3000,has_alpha=0,companions_ambiguous=0", []).unwrap();
        let listed = crate::core::import::list_clips(&c).unwrap();
        let a = listed.iter().find(|clip| clip.id == Some(1)).unwrap();
        let b = listed.iter().find(|clip| clip.id == Some(2)).unwrap();
        assert_eq!((a.binary_rating, a.select_count), (Some(-1), 0));
        assert_eq!((b.binary_rating, b.select_count), (Some(1), 1));
        assert_eq!(c.query_row("SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
        assert!(!get_session(&c, session.id).unwrap().undone);
        assert_eq!(c.query_row(
            "SELECT COUNT(*) FROM duel_verdicts WHERE session_id=?1 AND undone=0",
            [session.id],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1);
    }

    #[test]
    fn results_photo_duel_preserves_independent_manual_favorite_and_star_on_the_loser() {
        let mut c = result_photo_db("run-manual-rating");
        c.execute("INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES(101,'binary',1,'auto')", []).unwrap();
        crate::core::ratings::rate_clip(&mut c, 1, "binary", 1).unwrap();
        crate::core::ratings::rate_clip(&mut c, 1, "star", 4).unwrap();
        let session = start_duel(&mut c, result_photo_members(), "results").unwrap();
        let session = decide(&mut c, session.id, Some("photo:2".to_owned())).unwrap();
        let session = finish(&mut c, session.id).unwrap();
        c.execute("UPDATE photo_meta SET width=100,height=100,orientation=1,hold_ms=3000,has_alpha=0,companions_ambiguous=0", []).unwrap();
        let listed = crate::core::import::list_clips(&c).unwrap();
        let a = listed.iter().find(|clip| clip.id == Some(1)).unwrap();
        let b = listed.iter().find(|clip| clip.id == Some(2)).unwrap();
        assert_eq!((a.binary_rating, a.star_rating, a.select_count), (Some(1), Some(4), 0));
        assert_eq!((b.binary_rating, b.select_count), (Some(1), 1));
        undo_session(&mut c, session.id).unwrap();
        let listed = crate::core::import::list_clips(&c).unwrap();
        let a = listed.iter().find(|clip| clip.id == Some(1)).unwrap();
        let b = listed.iter().find(|clip| clip.id == Some(2)).unwrap();
        assert_eq!((a.binary_rating, a.star_rating, a.select_count), (Some(1), Some(4), 1));
        assert_eq!((b.binary_rating, b.select_count), (None, 0));
    }
    #[test]
    fn duel_undo_one_resumes_and_invalid_winner_is_atomic() {
        let mut c = db();
        let s = start_duel(&mut c, members(7), "manual").unwrap();
        assert!(decide(&mut c, s.id, Some("photo:7".into())).is_err());
        let next = decide(&mut c, s.id, Some(s.pair[1].clone())).unwrap();
        assert_eq!(next.round, 1);
        let restored = undo_last(&mut c, s.id).unwrap();
        assert_eq!(restored.pair, s.pair);
        assert_eq!(get_session(&c, s.id).unwrap().round, 0);
    }
    #[test]
    fn duel_mixed_keep_both_and_video_rejection_restore() {
        let mut c = db();
        c.execute("UPDATE clips SET kind='video',duration_ticks=9000 WHERE id IN (2,3)", []).unwrap();
        c.execute("INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind) VALUES(22,2,10,2000,'select'),(33,3,20,3000,'select')", []).unwrap();
        let ms = vec![
            Member { clip_id: 1, segment_id: None, result_segment_id: None, preview: None },
            Member { clip_id: 2, segment_id: Some(22), result_segment_id: None, preview: None },
            Member { clip_id: 3, segment_id: Some(33), result_segment_id: None, preview: None },
        ];
        let s = start_duel(&mut c, ms, "manual").unwrap();
        let s = decide(&mut c, s.id, None).unwrap();
        let s = decide(&mut c, s.id, Some("video:22".into())).unwrap();
        let s = finish(&mut c, s.id).unwrap();
        assert_eq!(s.winners.len(), 2);
        assert_eq!(c.query_row("SELECT kind FROM segments WHERE id=33", [], |r| r.get::<_, String>(0)).unwrap(), "rejected");
        undo_session(&mut c, s.id).unwrap();
        assert_eq!(c.query_row("SELECT kind FROM segments WHERE id=33", [], |r| r.get::<_, String>(0)).unwrap(), "select");
    }
    #[test]
    fn duel_unselected_video_candidates_are_private_until_finish_and_resume_without_duplicates() {
        let mut c = db();
        c.execute("UPDATE clips SET kind='video',duration_ticks=9000 WHERE id IN (1,2)", []).unwrap();
        let s = start_duel(&mut c, members(2), "results").unwrap();
        assert_eq!(start_duel(&mut c, members(2), "results").unwrap().id, s.id);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM segments WHERE kind='select'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM segments", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        assert!(s.members.iter().all(|m| m.preview.is_some()));
        decide(&mut c, s.id, Some(s.pair[1].clone())).unwrap(); finish(&mut c, s.id).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM segments WHERE kind='select'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        undo_session(&mut c, s.id).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM segments WHERE tombstone=0", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn undoing_older_duel_keeps_newer_duel_primary() {
        let mut c = db();
        let older = finish_with_photo_winner(&mut c, 2);
        finish_with_photo_winner(&mut c, 3);
        undo_session(&mut c, older.id).unwrap();
        assert_eq!(c.query_row(
            "SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 3);
    }

    #[test]
    fn undoing_older_duel_keeps_newer_manual_primary() {
        let mut c = db();
        let older = finish_with_photo_winner(&mut c, 2);
        crate::core::similar::set_primary(&mut c, 1, 4).unwrap();
        undo_session(&mut c, older.id).unwrap();
        assert_eq!(c.query_row(
            "SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 4);
    }

    #[test]
    fn undoing_a_same_winner_duel_restores_the_prior_manual_decision() {
        let mut c = db();
        crate::core::similar::set_primary(&mut c, 1, 2).unwrap();
        let duel = finish_with_photo_winner(&mut c, 2);
        undo_session(&mut c, duel.id).unwrap();
        assert_eq!(crate::core::similar::latest_primary_in_group(&c, 1).unwrap(), Some(2));
    }

    #[test]
    fn same_winner_duels_can_be_undone_in_reverse_to_the_initial_primary() {
        let mut c = db();
        let first = finish_with_photo_winner(&mut c, 2);
        let second = finish_with_photo_winner(&mut c, 2);

        undo_session(&mut c, second.id).unwrap();
        assert_eq!(c.query_row(
            "SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 2);
        undo_session(&mut c, first.id).unwrap();
        assert_eq!(c.query_row(
            "SELECT clip_id FROM similar_group_members WHERE group_id=1 AND is_primary=1",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1);
        assert_eq!(crate::core::similar::latest_primary_in_group(&c, 1).unwrap(), None);
    }

    #[test]
    fn legacy_completed_duel_without_later_edits_can_undo() {
        let mut c = db();
        let duel = finish_video_duel(&mut c);
        downgrade_snapshot_to_legacy(&c, duel.id);

        undo_session(&mut c, duel.id).unwrap();
        assert_eq!(c.query_row(
            "SELECT kind FROM segments WHERE id=33",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(), "select");
    }

    #[test]
    fn legacy_completed_duel_still_rejects_a_later_segment_edit() {
        let mut c = db();
        let duel = finish_video_duel(&mut c);
        downgrade_snapshot_to_legacy(&c, duel.id);
        c.execute("UPDATE segments SET kind='select' WHERE id=33", []).unwrap();

        let error = undo_session(&mut c, duel.id).unwrap_err().to_string();
        assert!(error.contains("后来"), "{error}");
        assert_eq!(c.query_row(
            "SELECT kind FROM segments WHERE id=33",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(), "select");
    }

    #[test]
    fn undo_refuses_to_overwrite_later_video_segment_and_stack_edits() {
        let mut c = db();
        c.execute("UPDATE clips SET kind='video',duration_ticks=9000 WHERE id IN (2,3)", []).unwrap();
        c.execute(
            "INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind) VALUES
             (22,2,10,2000,'select'),(33,3,20,3000,'select')",
            [],
        ).unwrap();
        c.execute("INSERT INTO scenes(id,episode_id,name,kind) VALUES(10,1,'test','test')", []).unwrap();
        c.execute(
            "INSERT INTO shot_stacks(id,scene_id,subject_label,function_label,created_at)
             VALUES(10,10,'subject','function','now')",
            [],
        ).unwrap();
        c.execute(
            "INSERT INTO shot_stack_members(stack_id,clip_id,segment_id,score_breakdown_json,user_state)
             VALUES(10,3,33,'{}','auto')",
            [],
        ).unwrap();
        let members = vec![
            Member { clip_id: 2, segment_id: Some(22), result_segment_id: None, preview: None },
            Member { clip_id: 3, segment_id: Some(33), result_segment_id: None, preview: None },
        ];
        let session = start_duel(&mut c, members, "shot_stack").unwrap();
        let session = decide(&mut c, session.id, Some("video:22".to_owned())).unwrap();
        let session = finish(&mut c, session.id).unwrap();
        assert_eq!(c.query_row("SELECT kind FROM segments WHERE id=33", [], |row| row.get::<_, String>(0)).unwrap(), "rejected");
        assert_eq!(c.query_row("SELECT user_state FROM shot_stack_members WHERE segment_id=33", [], |row| row.get::<_, String>(0)).unwrap(), "rejected");

        c.execute("UPDATE segments SET kind='select' WHERE id=33", []).unwrap();
        c.execute("UPDATE shot_stack_members SET user_state='hero' WHERE segment_id=33", []).unwrap();
        let error = undo_session(&mut c, session.id).unwrap_err().to_string();
        assert!(error.contains("后来"), "{error}");
        assert_eq!(c.query_row("SELECT kind FROM segments WHERE id=33", [], |row| row.get::<_, String>(0)).unwrap(), "select");
        assert_eq!(c.query_row("SELECT user_state FROM shot_stack_members WHERE segment_id=33", [], |row| row.get::<_, String>(0)).unwrap(), "hero");
        assert!(!get_session(&c, session.id).unwrap().undone);
    }

    #[test]
    fn undo_refuses_to_tombstone_a_created_segment_after_a_later_edit() {
        let mut c = db();
        c.execute("UPDATE clips SET kind='video',duration_ticks=9000 WHERE id IN (1,2)", []).unwrap();
        let session = start_duel(&mut c, members(2), "results").unwrap();
        let created = session.members[0].segment_id.unwrap();
        let session = decide(&mut c, session.id, Some(session.pair[0].clone())).unwrap();
        let session = finish(&mut c, session.id).unwrap();
        c.execute("UPDATE segments SET in_ticks=in_ticks+1 WHERE id=?1", [created]).unwrap();

        let error = undo_session(&mut c, session.id).unwrap_err().to_string();
        assert!(error.contains("后来"), "{error}");
        assert_eq!(c.query_row(
            "SELECT tombstone FROM segments WHERE id=?1",
            [created],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 0);
        assert!(!get_session(&c, session.id).unwrap().undone);
    }
}
