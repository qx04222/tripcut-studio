use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::analysis::{DARK_YAVG_THRESHOLD, OVEREXPOSED_RATIO_THRESHOLD, SOFT_FOCUS_THRESHOLD};
use super::error::{CoreError, Result};
use super::ratings::SelectSegment;
use super::settings;

const LOW_TECHNICAL_SCORE: f64 = 0.35;
const HIGH_NARRATIVE_SCORE: f64 = 0.70;
const MIN_RESCUE_SECONDS: usize = 2;

const EMOTION_WORDS: [&str; 16] = [
    "惊喜", "惊讶", "害怕", "紧张", "激动", "感动", "开心", "大笑",
    "哭", "天啊", "糟了", "没想到", "终于", "救命", "哇", "啊",
];
const UNIQUE_EVENT_WORDS: [&str; 18] = [
    "unique_event", "独特事件", "不可重拍", "熊", "野生动物", "陷车", "爆胎",
    "冰雹", "暴雪", "极端天气", "故障", "边检", "偶遇", "意外发现", "事故",
    "第一次", "唯一", "突发",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RescueRange {
    pub in_ticks: i64,
    pub out_ticks: i64,
    pub tb_num: i64,
    pub tb_den: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AssetSafetyInfo {
    pub clip_id: i64,
    pub safety_flag: String,
    pub image_score: Option<f64>,
    pub motion_score: Option<f64>,
    pub audio_score: Option<f64>,
    pub narrative_score: f64,
    pub narrative_signals: Vec<String>,
    pub rescue_range: Option<RescueRange>,
    pub rescue_suggestions: Vec<String>,
}

#[derive(Debug, Clone)]
struct Candidate {
    clip_id: i64,
    tb_num: Option<i64>,
    tb_den: Option<i64>,
    duration_ticks: Option<i64>,
    safety_flag: String,
    exposure_yavg: Option<f64>,
    overexposed_ratio: Option<f64>,
    focus_scores_json: Option<String>,
    audio_peak_db: Option<f64>,
    audio_clipped: Option<bool>,
    has_audio: Option<bool>,
    shake_score: Option<f64>,
    motion_metadata: Option<String>,
    function_label: String,
    function_score: f64,
    person_state_label: String,
    transcript_text: String,
    tag_text: String,
    unexpected_chapter: bool,
}

#[derive(Debug, Clone)]
struct Assessment {
    flag: &'static str,
    image_score: Option<f64>,
    motion_score: Option<f64>,
    audio_score: Option<f64>,
    narrative_score: f64,
    narrative_signals: Vec<String>,
}

pub fn refresh_all(connection: &mut Connection) -> Result<usize> {
    let jitter_threshold = settings::number_value(
        connection,
        settings::JITTER_THRESHOLD_KEY,
        settings::DEFAULT_JITTER_THRESHOLD,
    )?
    .clamp(0.01, 2.0);
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let candidates = load_candidates(&transaction)?;
    let mut changed_flags = 0_usize;
    for candidate in &candidates {
        let assessment = assess(candidate, jitter_threshold);
        if candidate.safety_flag != assessment.flag {
            changed_flags += 1;
        }
        transaction.execute(
            "UPDATE clips SET safety_flag = ?2 WHERE id = ?1",
            params![candidate.clip_id, assessment.flag],
        )?;
        let range = (assessment.flag == "rescue_candidate")
            .then(|| rescue_range(candidate))
            .flatten();
        if let Some(range) = range {
            transaction.execute(
                "INSERT INTO rescue_ranges(clip_id, in_ticks, out_ticks, reason)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(clip_id) DO UPDATE SET
                   in_ticks = excluded.in_ticks,
                   out_ticks = excluded.out_ticks,
                   reason = excluded.reason",
                params![candidate.clip_id, range.in_ticks, range.out_ticks, range.reason],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM rescue_ranges WHERE clip_id = ?1",
                [candidate.clip_id],
            )?;
        }
    }
    transaction.commit()?;
    Ok(changed_flags)
}

pub fn list(connection: &Connection) -> Result<Vec<AssetSafetyInfo>> {
    let jitter_threshold = settings::number_value(
        connection,
        settings::JITTER_THRESHOLD_KEY,
        settings::DEFAULT_JITTER_THRESHOLD,
    )?
    .clamp(0.01, 2.0);
    let candidates = load_candidates(connection)?;
    let mut result = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let assessment = assess(&candidate, jitter_threshold);
        let stored_range = connection
            .query_row(
                "SELECT in_ticks, out_ticks, reason FROM rescue_ranges WHERE clip_id = ?1",
                [candidate.clip_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let rescue_range = match (
            stored_range,
            candidate.tb_num.filter(|value| *value > 0),
            candidate.tb_den.filter(|value| *value > 0),
        ) {
            (Some((in_ticks, out_ticks, reason)), Some(tb_num), Some(tb_den)) => {
                Some(RescueRange { in_ticks, out_ticks, tb_num, tb_den, reason })
            }
            _ => None,
        };
        let rescue_suggestions = rescue_suggestions(&candidate, &assessment);
        result.push(AssetSafetyInfo {
            clip_id: candidate.clip_id,
            safety_flag: candidate.safety_flag.clone(),
            image_score: assessment.image_score,
            motion_score: assessment.motion_score,
            audio_score: assessment.audio_score,
            narrative_score: assessment.narrative_score,
            narrative_signals: assessment.narrative_signals,
            rescue_range,
            rescue_suggestions,
        });
    }
    result.sort_by_key(|item| match item.safety_flag.as_str() {
        "rescue_candidate" => (0_u8, item.clip_id),
        "normal" => (1_u8, item.clip_id),
        "likely_unusable" => (2_u8, item.clip_id),
        _ => (3_u8, item.clip_id),
    });
    Ok(result)
}

pub fn apply_rescue_range(connection: &mut Connection, clip_id: i64) -> Result<SelectSegment> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let timing = transaction
        .query_row(
            "SELECT rr.in_ticks, rr.out_ticks, clip.tb_num, clip.tb_den
             FROM rescue_ranges rr
             JOIN clips clip ON clip.id = rr.clip_id
             WHERE rr.clip_id = ?1 AND clip.safety_flag = 'rescue_candidate'",
            [clip_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::AssetSafety(format!("素材 {clip_id} 没有可应用的抢救区间")))?;
    let existing = transaction
        .query_row(
            "SELECT id FROM segments
             WHERE clip_id = ?1 AND kind = 'select' AND tombstone = 0
               AND in_ticks = ?2 AND out_ticks = ?3
             ORDER BY id LIMIT 1",
            params![clip_id, timing.0, timing.1],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let segment_id = if let Some(segment_id) = existing {
        segment_id
    } else {
        transaction.execute(
            "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind, tombstone)
             VALUES (?1, ?2, ?3, 'select', 0)",
            params![clip_id, timing.0, timing.1],
        )?;
        let segment_id = transaction.last_insert_rowid();
        transaction.execute(
            "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
             VALUES (?1, 'binary', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [segment_id],
        )?;
        segment_id
    };
    transaction.commit()?;
    Ok(SelectSegment {
        id: segment_id,
        clip_id,
        in_ticks: timing.0,
        out_ticks: timing.1,
        tb_num: timing.2,
        tb_den: timing.3,
    })
}

pub(crate) fn narrative_signal_score(
    function_label: &str,
    function_score: f64,
    person_state_label: &str,
    transcript_text: &str,
    tag_text: &str,
    unexpected_chapter: bool,
) -> (f64, Vec<String>) {
    let mut score = 0.0_f64;
    let mut signals = Vec::new();
    if function_label == "Human-Reaction" {
        score = score.max(function_score.clamp(0.80, 1.0));
        signals.push("八维⑥真实反应".to_owned());
    }
    if matches!(person_state_label, "自然反应" | "互动") {
        score = score.max(0.80);
        signals.push(format!("人物状态:{person_state_label}"));
    }
    if let Some(word) = EMOTION_WORDS.iter().find(|word| transcript_text.contains(**word)) {
        score = score.max(0.82);
        signals.push(format!("转写情绪词:{word}"));
    }
    if let Some(word) = UNIQUE_EVENT_WORDS
        .iter()
        .find(|word| tag_text.contains(**word) || transcript_text.contains(**word))
    {
        score = 1.0;
        signals.push(format!("unique_event:{word}"));
    }
    if unexpected_chapter {
        score = 1.0;
        signals.push("叙事章节:unexpected".to_owned());
    }
    signals.sort();
    signals.dedup();
    (score, signals)
}

fn load_candidates(connection: &Connection) -> Result<Vec<Candidate>> {
    let mut statement = connection.prepare(
        "SELECT clip.id, clip.tb_num, clip.tb_den, clip.duration_ticks, clip.safety_flag,
                analysis.exposure_yavg, analysis.overexposed_ratio, analysis.focus_scores,
                analysis.audio_peak_db, analysis.audio_clipped, analysis.has_audio,
                motion.shake_score, motion.tool_version,
                COALESCE(function.label, '不确定'), COALESCE(function.score, 0.0),
                COALESCE(person.label, '不确定'),
                COALESCE((SELECT GROUP_CONCAT(text, ' ') FROM transcript_segments transcript
                          WHERE transcript.clip_id = clip.id), ''),
                COALESCE((SELECT GROUP_CONCAT(tag.label, ' ') FROM tags tag
                          JOIN segments segment ON segment.id = tag.segment_id
                          WHERE segment.clip_id = clip.id), ''),
                EXISTS(SELECT 1 FROM narrative_beats beat
                       JOIN narrative_chapters chapter ON chapter.id = beat.chapter_id
                       WHERE beat.clip_id = clip.id AND chapter.kind = 'unexpected')
         FROM clips clip
         LEFT JOIN clip_analysis analysis ON analysis.clip_id = clip.id
         LEFT JOIN clip_motion motion ON motion.clip_id = clip.id
         LEFT JOIN clip_dimensions function
           ON function.clip_id = clip.id AND function.dimension = 'function'
         LEFT JOIN clip_dimensions person
           ON person.clip_id = clip.id AND person.dimension = 'person_state'
         ORDER BY clip.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(Candidate {
            clip_id: row.get(0)?,
            tb_num: row.get(1)?,
            tb_den: row.get(2)?,
            duration_ticks: row.get(3)?,
            safety_flag: row.get(4)?,
            exposure_yavg: row.get(5)?,
            overexposed_ratio: row.get(6)?,
            focus_scores_json: row.get(7)?,
            audio_peak_db: row.get(8)?,
            audio_clipped: row.get::<_, Option<i64>>(9)?.map(|value| value == 1),
            has_audio: row.get::<_, Option<i64>>(10)?.map(|value| value == 1),
            shake_score: row.get(11)?,
            motion_metadata: row.get(12)?,
            function_label: row.get(13)?,
            function_score: row.get(14)?,
            person_state_label: row.get(15)?,
            transcript_text: row.get(16)?,
            tag_text: row.get(17)?,
            unexpected_chapter: row.get::<_, i64>(18)? == 1,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(CoreError::from)
}

fn assess(candidate: &Candidate, jitter_threshold: f64) -> Assessment {
    let image_score = image_score(candidate);
    let motion_score = candidate
        .shake_score
        .map(|shake| (1.0 - shake / (jitter_threshold * 3.0)).clamp(0.0, 1.0));
    let audio_score = audio_score(candidate);
    let (narrative_score, narrative_signals) = narrative_signal_score(
        &candidate.function_label,
        candidate.function_score,
        &candidate.person_state_label,
        &candidate.transcript_text,
        &candidate.tag_text,
        candidate.unexpected_chapter,
    );
    let technical_low = [image_score, motion_score, audio_score]
        .into_iter()
        .all(|score| score.is_some_and(|value| value <= LOW_TECHNICAL_SCORE));
    let flag = if technical_low && narrative_score >= HIGH_NARRATIVE_SCORE {
        "rescue_candidate"
    } else if technical_low {
        "likely_unusable"
    } else {
        "normal"
    };
    Assessment {
        flag,
        image_score,
        motion_score,
        audio_score,
        narrative_score,
        narrative_signals,
    }
}

fn image_score(candidate: &Candidate) -> Option<f64> {
    let focus_scores = serde_json::from_str::<Vec<f64>>(candidate.focus_scores_json.as_deref()?)
        .ok()?
        .into_iter()
        .filter(|score| score.is_finite())
        .collect::<Vec<_>>();
    if focus_scores.is_empty() {
        return None;
    }
    let focus = (focus_scores.iter().sum::<f64>()
        / focus_scores.len() as f64
        / (SOFT_FOCUS_THRESHOLD * 2.0))
        .clamp(0.0, 1.0);
    let exposure = (candidate.exposure_yavg? / DARK_YAVG_THRESHOLD).clamp(0.0, 1.0);
    let highlights = (1.0
        - candidate.overexposed_ratio? / OVEREXPOSED_RATIO_THRESHOLD.max(f64::EPSILON))
        .clamp(0.0, 1.0);
    Some((focus + exposure + highlights) / 3.0)
}

fn audio_score(candidate: &Candidate) -> Option<f64> {
    let has_audio = candidate.has_audio?;
    if !has_audio {
        return Some(0.25);
    }
    if contains_any(&candidate.tag_text, &["风噪", "噪声", "爆音", "clipped"]) {
        return Some(0.15);
    }
    if candidate.audio_clipped == Some(true) {
        return Some(0.15);
    }
    candidate.audio_peak_db.map(|peak| {
        if peak <= -45.0 {
            0.20
        } else {
            ((peak + 45.0) / 45.0).clamp(0.0, 1.0)
        }
    })
}

fn rescue_suggestions(candidate: &Candidate, assessment: &Assessment) -> Vec<String> {
    if assessment.flag != "rescue_candidate" {
        return Vec::new();
    }
    let mut suggestions = Vec::new();
    if assessment.motion_score.is_some_and(|score| score <= LOW_TECHNICAL_SCORE) {
        suggestions.extend(["稳定".to_owned(), "裁切".to_owned()]);
    }
    if assessment.audio_score.is_some_and(|score| score <= LOW_TECHNICAL_SCORE) {
        if contains_any(&format!("{} {}", candidate.tag_text, candidate.transcript_text), &["风噪", "大风", "wind"])
        {
            suggestions.push("VO 覆盖建议".to_owned());
        } else {
            suggestions.push("降噪".to_owned());
        }
    }
    suggestions.sort();
    suggestions.dedup();
    suggestions
}

fn rescue_range(candidate: &Candidate) -> Option<RescueRange> {
    let tb_num = candidate.tb_num.filter(|value| *value > 0)?;
    let tb_den = candidate.tb_den.filter(|value| *value > 0)?;
    let duration_ticks = candidate.duration_ticks.filter(|value| *value > 0)?;
    let samples = parse_series(candidate.motion_metadata.as_deref()?, "second_shake")?;
    let full_seconds = i128::from(duration_ticks)
        .checked_mul(i128::from(tb_num))?
        / i128::from(tb_den);
    let usable_samples = usize::try_from(full_seconds).ok()?.min(samples.len());
    let (start_second, end_second, mean_shake) =
        best_contiguous_window(&samples[..usable_samples], MIN_RESCUE_SECONDS)?;
    let in_ticks = second_index_to_ticks(start_second, tb_num, tb_den)?;
    let out_ticks = second_index_to_ticks(end_second, tb_num, tb_den)?.min(duration_ticks);
    let minimum_duration = i128::from(MIN_RESCUE_SECONDS as i64) * i128::from(tb_den);
    let actual_duration = i128::from(out_ticks - in_ticks) * i128::from(tb_num);
    if out_ticks <= in_ticks || actual_duration < minimum_duration {
        return None;
    }
    Some(RescueRange {
        in_ticks,
        out_ticks,
        tb_num,
        tb_den,
        reason: format!(
            "C6 逐秒抖动最低连续窗（{}s，均值 {:.3}）；仅建议区间，原片完整保留",
            end_second - start_second,
            mean_shake
        ),
    })
}

fn parse_series(metadata: &str, key: &str) -> Option<Vec<f64>> {
    let prefix = format!("{key}=");
    let value = metadata
        .split(';')
        .find_map(|part| part.trim().strip_prefix(&prefix))?
        .split_whitespace()
        .next()?;
    let values = value
        .split(',')
        .filter(|part| !part.is_empty())
        .map(str::parse::<f64>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok()?;
    (!values.is_empty() && values.iter().all(|value| value.is_finite())).then_some(values)
}

fn best_contiguous_window(samples: &[f64], minimum: usize) -> Option<(usize, usize, f64)> {
    if minimum == 0 || samples.len() < minimum || samples.iter().any(|value| !value.is_finite()) {
        return None;
    }
    (0..=samples.len() - minimum)
        .map(|start| {
            let end = start + minimum;
            let mean = samples[start..end].iter().sum::<f64>() / minimum as f64;
            (start, end, mean)
        })
        .min_by(|left, right| left.2.total_cmp(&right.2).then(left.0.cmp(&right.0)))
}

fn second_index_to_ticks(second: usize, tb_num: i64, tb_den: i64) -> Option<i64> {
    if tb_num <= 0 || tb_den <= 0 {
        return None;
    }
    let numerator = i128::try_from(second).ok()?.checked_mul(i128::from(tb_den))?;
    let rounded = numerator.checked_add(i128::from(tb_num) / 2)? / i128::from(tb_num);
    i64::try_from(rounded).ok()
}

fn contains_any(text: &str, words: &[&str]) -> bool {
    let lowercase = text.to_lowercase();
    words.iter().any(|word| lowercase.contains(&word.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn candidate() -> Candidate {
        Candidate {
            clip_id: 1,
            tb_num: Some(1),
            tb_den: Some(1_000),
            duration_ticks: Some(10_000),
            safety_flag: "normal".to_owned(),
            exposure_yavg: Some(8.0),
            overexposed_ratio: Some(0.30),
            focus_scores_json: Some("[5.0,6.0,4.0]".to_owned()),
            audio_peak_db: Some(-50.0),
            audio_clipped: Some(false),
            has_audio: Some(true),
            shake_score: Some(2.0),
            motion_metadata: Some(
                "analyze_motion/v4;second_shake=8.0,7.0,0.2,0.1,4.0".to_owned(),
            ),
            function_label: "Atmosphere".to_owned(),
            function_score: 0.2,
            person_state_label: "不确定".to_owned(),
            transcript_text: String::new(),
            tag_text: String::new(),
            unexpected_chapter: false,
        }
    }

    fn database() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        (directory, connection)
    }

    fn insert_low_clip(connection: &Connection, transcript: &str) {
        connection.execute(
            "INSERT INTO clips(id, volume_uuid, rel_path, tb_num, tb_den, duration_ticks)
             VALUES (1, 'v', 'clip.mov', 1, 1000, 10000)",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO clip_analysis(
               clip_id, exposure_yavg, overexposed_ratio, audio_peak_db, audio_clipped,
               has_audio, focus_scores, scene_count, analyzed_at, tool_versions
             ) VALUES (1, 8, 0.30, -50, 0, 1, '[5,6,4]', 1, 'now', '{}')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO clip_motion(
               clip_id, class, pan_ratio, tilt_ratio, zoom_corr, shake_score,
               sample_pairs, tool_version
             ) VALUES (1, 'handheld', 0, 0, 0, 2, 10,
                       'analyze_motion/v4;second_shake=8,7,0.2,0.1,4')",
            [],
        ).unwrap();
        if !transcript.is_empty() {
            connection.execute(
                "INSERT INTO transcript_segments(clip_id, seg_index, start_ticks, end_ticks, text)
                 VALUES (1, 0, 0, 1000, ?1)",
                [transcript],
            ).unwrap();
        }
    }

    #[test]
    fn all_low_with_no_narrative_signal_is_likely_unusable() {
        assert_eq!(assess(&candidate(), 0.6).flag, "likely_unusable");
    }

    #[test]
    fn all_low_with_real_reaction_is_rescue_candidate() {
        let assessment = assess(&Candidate {
            function_label: "Human-Reaction".to_owned(),
            function_score: 0.91,
            ..candidate()
        }, 0.6);
        assert_eq!(assessment.flag, "rescue_candidate");
        assert!(assessment.narrative_signals.iter().any(|signal| signal.contains("真实反应")));
    }

    #[test]
    fn unique_event_tag_has_veto_weight() {
        let assessment = assess(&Candidate {
            tag_text: "旅行 unique_event 熊".to_owned(),
            ..candidate()
        }, 0.6);
        assert_eq!(assessment.narrative_score, 1.0);
        assert_eq!(assessment.flag, "rescue_candidate");
    }

    #[test]
    fn incomplete_technical_evidence_never_marks_a_clip_unusable() {
        let assessment = assess(&Candidate { shake_score: None, ..candidate() }, 0.6);
        assert_eq!(assessment.flag, "normal");
    }

    #[test]
    fn migration_rejects_unknown_flags_and_empty_rescue_ranges() {
        let (_directory, connection) = database();
        connection.execute(
            "INSERT INTO clips(id, volume_uuid, rel_path, tb_num, tb_den, duration_ticks)
             VALUES (1, 'v', 'clip.mov', 1, 1000, 10000)",
            [],
        ).unwrap();

        assert!(connection.execute(
            "UPDATE clips SET safety_flag = 'deleted' WHERE id = 1",
            [],
        ).is_err());
        assert!(connection.execute(
            "INSERT INTO rescue_ranges(clip_id, in_ticks, out_ticks, reason)
             VALUES (1, 500, 500, 'invalid')",
            [],
        ).is_err());
    }

    #[test]
    fn best_window_chooses_the_lowest_two_second_run() {
        let (start, end, mean) = best_contiguous_window(&[8.0, 7.0, 0.2, 0.1, 4.0], 2).unwrap();
        assert_eq!((start, end), (2, 4));
        assert!((mean - 0.15).abs() < 1e-9);
    }

    #[test]
    fn rescue_range_uses_exact_source_ticks() {
        let range = rescue_range(&candidate()).unwrap();
        assert_eq!((range.in_ticks, range.out_ticks), (2_000, 4_000));
    }

    #[test]
    fn refresh_persists_likely_unusable_without_removing_clip() {
        let (_directory, mut connection) = database();
        insert_low_clip(&connection, "");

        refresh_all(&mut connection).unwrap();

        let state: (String, i64) = connection.query_row(
            "SELECT safety_flag, (SELECT COUNT(*) FROM clips) FROM clips WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(state, ("likely_unusable".to_owned(), 1));
    }

    #[test]
    fn refresh_persists_rescue_window_and_one_click_select_is_idempotent() {
        let (_directory, mut connection) = database();
        insert_low_clip(&connection, "天啊，熊就在路边");
        refresh_all(&mut connection).unwrap();

        let first = apply_rescue_range(&mut connection, 1).unwrap();
        let second = apply_rescue_range(&mut connection, 1).unwrap();

        assert_eq!((first.in_ticks, first.out_ticks), (2_000, 4_000));
        assert_eq!(first.id, second.id);
        let selects: i64 = connection.query_row(
            "SELECT COUNT(*) FROM segments WHERE kind = 'select' AND tombstone = 0",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(selects, 1);
    }

    #[test]
    fn rescue_advice_is_copy_only_and_maps_shake_and_audio_defects() {
        let candidate = Candidate { tag_text: "强风噪".to_owned(), ..candidate() };
        let assessment = assess(&Candidate {
            transcript_text: "天啊，突然爆胎".to_owned(),
            ..candidate.clone()
        }, 0.6);
        let suggestions = rescue_suggestions(&candidate, &assessment);
        assert!(suggestions.contains(&"稳定".to_owned()));
        assert!(suggestions.contains(&"裁切".to_owned()));
        assert!(suggestions.contains(&"VO 覆盖建议".to_owned()));
    }

    #[test]
    fn source_path_modules_contain_no_filesystem_delete_api() {
        let source_modules = [
            ("media_source.rs", include_str!("media_source.rs")),
            ("import.rs", include_str!("import.rs")),
        ];
        for (name, source) in source_modules {
            assert!(
                !source.contains("std::fs::remove_file"),
                "{name} may not delete source files"
            );
            assert!(
                !source.contains("std::fs::remove_dir_all"),
                "{name} may not delete source directories"
            );
            assert!(
                !source.contains("Command::new(\"rm\")"),
                "{name} may not shell out to rm"
            );
        }

        let source_consumers = [
            ("analysis.rs", include_str!("analysis.rs")),
            ("motion.rs", include_str!("motion.rs")),
            ("transcribe.rs", include_str!("transcribe.rs")),
            ("artifacts.rs", include_str!("artifacts.rs")),
            ("deliver.rs", include_str!("deliver.rs")),
            ("jianying.rs", include_str!("jianying.rs")),
        ];
        for (name, source) in source_consumers {
            for forbidden in [
                "remove_file(&source.path",
                "remove_file(source.path",
                "remove_dir_all(&source.path",
                "remove_dir_all(source.path",
                "remove_file(&payload.path",
                "remove_file(payload.path",
                "remove_dir_all(&payload.path",
                "remove_dir_all(payload.path",
            ] {
                assert!(
                    !source.contains(forbidden),
                    "{name} passes an original-media path to a deletion API: {forbidden}"
                );
            }
        }
    }
}
