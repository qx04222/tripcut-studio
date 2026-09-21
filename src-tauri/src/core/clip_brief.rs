//! R18 AI-A1:**零云端**的本地素材描述。
//!
//! 背景:`ai_descriptions` 那条路要云端 CLI、要月度预算、8 GB 机器上还整块关掉,
//! 而同一条素材的画面标签(`clip_dimensions`)、画面文字(`clip_ocr_texts`)、
//! 对白(`transcript_segments`)三张表**早就落库了**,一个都没被用来说人话。
//! 这里把它们拼成一句中文,不调任何模型、不联网、离线可用。
//!
//! 同一份事实还喂给云端 prompt(`llm::description_prompt`),所以本地这句和云端那句
//! 说的是同一批东西 —— 云端只是把它润色一遍,不再是凭 19 个数字编。

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};

use super::error::Result;

/// 低于这个置信度的标签当作不可靠,不进描述也不进 prompt。
pub const MIN_LABEL_SCORE: f32 = super::clip_dimensions::UNCERTAIN_THRESHOLD;
/// 画面文字最多取几条(按置信度)。
const MAX_OCR_PHRASES: usize = 3;
/// 一句描述里对白最多带多少字。
const MAX_SPEECH_CHARS: usize = 24;

/// 喂给「本地描述」与「云端 prompt」的同一份事实。
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct BriefFacts {
    /// 维度 → (标签, 置信度),已按 `MIN_LABEL_SCORE` 过滤。
    pub dimensions: BTreeMap<String, (String, f32)>,
    /// 运镜类的中文说法(`固定机位` / `横摇` / …),没分析过就是 None。
    pub motion: Option<String>,
    /// 画面里认出的文字,置信度前 `MAX_OCR_PHRASES` 条。
    pub ocr_phrases: Vec<String>,
    /// 对白首句(已截断)。
    pub speech: Option<String>,
    /// 时刻分里分数最高的那一窗(秒),给云端 prompt 说"最好的一段在哪"。
    pub best_moment: Option<(f64, f64)>,
    pub fixable: Vec<String>,
}

fn motion_label(class: &str) -> &'static str {
    match class {
        "pan" => "横摇",
        "tilt" => "俯仰",
        "zoom" => "变焦",
        "handheld" => "手持",
        "static" => "固定机位",
        _ => "运镜不明",
    }
}

fn truncate_chars(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_owned();
    }
    let mut kept: String = trimmed.chars().take(limit).collect();
    kept.push('…');
    kept
}

pub fn collect_facts(connection: &Connection, clip_id: i64) -> Result<BriefFacts> {
    let mut facts = BriefFacts::default();

    let mut statement = connection.prepare(
        "SELECT dimension, label, score FROM clip_dimensions WHERE clip_id = ?1",
    )?;
    let rows = statement.query_map([clip_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, f64>(2)? as f32,
        ))
    })?;
    for row in rows {
        let (dimension, label, score) = row?;
        if score >= MIN_LABEL_SCORE && !label.trim().is_empty() {
            facts.dimensions.insert(dimension, (label, score));
        }
    }
    drop(statement);

    facts.motion = connection
        .query_row(
            "SELECT class FROM clip_motion WHERE clip_id = ?1",
            [clip_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|class| motion_label(&class).to_owned());

    let mut statement = connection.prepare(
        "SELECT text FROM clip_ocr_texts WHERE clip_id = ?1
         ORDER BY confidence DESC, frame_tick, id",
    )?;
    let rows = statement.query_map([clip_id], |row| row.get::<_, String>(0))?;
    for row in rows {
        let text = row?.trim().to_owned();
        if text.is_empty() || facts.ocr_phrases.iter().any(|kept| kept == &text) {
            continue;
        }
        facts.ocr_phrases.push(text);
        if facts.ocr_phrases.len() >= MAX_OCR_PHRASES {
            break;
        }
    }
    drop(statement);

    facts.speech = connection
        .query_row(
            "SELECT text FROM transcript_segments WHERE clip_id = ?1
             ORDER BY start_ticks, seg_index LIMIT 1",
            [clip_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|text| truncate_chars(&text, MAX_SPEECH_CHARS))
        .filter(|text| !text.is_empty());

    facts.best_moment = connection
        .query_row(
            "SELECT c.tb_num, c.tb_den, m.t_start_ticks, m.t_end_ticks
             FROM clip_moments m JOIN clips c ON c.id = m.clip_id
             WHERE m.clip_id = ?1 ORDER BY m.score DESC, m.win_index LIMIT 1",
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
        .map(|(tb_num, tb_den, start, end)| {
            (
                super::moments::ticks_to_seconds(start, tb_num, tb_den),
                super::moments::ticks_to_seconds(end, tb_num, tb_den),
            )
        });

    let moments = super::smart_select::moments_with_weights(connection, clip_id, None)?;
    facts.fixable = super::smart_select::reason::Reason::from_moments(&moments).fixable;
    Ok(facts)
}

/// 把事实拼成一句白话中文。**任何输入组合都必须产出非空、不含内部术语的句子**
/// —— 8 GB 机器上没有 CLIP、没有 OCR、也可能没有转写,那时它只剩运镜一条线索。
pub fn render(facts: &BriefFacts) -> String {
    let label = |key: &str| facts.dimensions.get(key).map(|(label, _)| label.as_str());
    let mut parts: Vec<String> = Vec::new();

    let subject = label("subject");
    let shot_size = label("shot_size");
    let viewpoint = label("viewpoint");
    let head = match (viewpoint, shot_size, subject) {
        (viewpoint, shot_size, Some(subject)) => {
            let mut prefix = String::new();
            if let Some(viewpoint) = viewpoint {
                prefix.push_str(viewpoint);
            }
            if let Some(shot_size) = shot_size {
                prefix.push_str(shot_size);
            }
            if prefix.is_empty() {
                Some(format!("拍的是{subject}"))
            } else {
                Some(format!("{prefix}的{subject}"))
            }
        }
        (_, Some(shot_size), None) => Some(format!("一个{shot_size}镜头")),
        _ => None,
    };
    if let Some(head) = head {
        parts.push(head);
    }
    if let Some(person_state) = label("person_state") {
        parts.push(format!("画面里的人在{person_state}"));
    }
    if let Some(motion) = &facts.motion {
        parts.push(format!("{motion}拍摄"));
    }
    if !facts.ocr_phrases.is_empty() {
        parts.push(format!("画面文字「{}」", facts.ocr_phrases.join("、")));
    }
    if let Some(speech) = &facts.speech {
        parts.push(format!("有人说「{speech}」", speech = speech.trim_end_matches('。')));
    }

    if !facts.fixable.is_empty() {
        parts.push(format!("可修:{}", facts.fixable.join("、")));
    }
    if parts.is_empty() {
        // 什么都没有也要给一句话 —— 空字符串会让界面显示成"还没有描述",
        // 而事实是"分析还没跑完",两件事不能长一个样。
        return "这条素材还没分析出可说的内容,先跑一次分析再看。".to_owned();
    }
    format!("{}。", parts.join(","))
}

/// 算一次并写进 `clips.local_brief`(迁移 0045),返回那句话。
pub fn refresh_for_clip(connection: &Connection, clip_id: i64) -> Result<String> {
    let facts = collect_facts(connection, clip_id)?;
    let brief = render(&facts);
    connection.execute(
        "UPDATE clips SET local_brief = ?2 WHERE id = ?1",
        rusqlite::params![clip_id, brief],
    )?;
    Ok(brief)
}

/// 界面用:有缓存就读缓存,没有就当场算一次并落库。
pub fn get_clip_brief(connection: &Connection, clip_id: i64) -> Result<Option<String>> {
    let exists: Option<Option<String>> = connection
        .query_row(
            "SELECT local_brief FROM clips WHERE id = ?1",
            [clip_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?;
    match exists {
        None => Ok(None),
        Some(Some(brief)) if !brief.trim().is_empty() => Ok(Some(brief)),
        Some(_) => refresh_for_clip(connection, clip_id).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts_with(dimensions: &[(&str, &str)], motion: Option<&str>, ocr: &[&str], speech: Option<&str>) -> BriefFacts {
        BriefFacts {
            dimensions: dimensions
                .iter()
                .map(|(key, label)| ((*key).to_owned(), ((*label).to_owned(), 0.9_f32)))
                .collect(),
            motion: motion.map(|class| motion_label(class).to_owned()),
            ocr_phrases: ocr.iter().map(|text| (*text).to_owned()).collect(),
            speech: speech.map(str::to_owned),
            best_moment: None,
            fixable: Vec::new(),
        }
    }

    /// 内部术语黑名单:业主规则「文案不出现内部术语」。
    const JARGON: [&str; 10] = [
        "clip", "tick", "ticks", "L1", "sidecar", "OCR", "CLIP", "embedding", "moment", "VFR",
    ];

    fn assert_plain(text: &str) {
        assert!(!text.trim().is_empty(), "描述不能为空");
        for word in JARGON {
            assert!(!text.contains(word), "描述里不该出现内部术语 {word}:{text}");
        }
    }

    #[test]
    fn full_labels_render_one_sentence() {
        let facts = facts_with(
            &[
                ("subject", "食物"),
                ("shot_size", "近景"),
                ("viewpoint", "俯拍"),
                ("person_state", "吃喝"),
            ],
            Some("handheld"),
            &["城南面馆"],
            Some("这家的面真不错。"),
        );
        let text = render(&facts);
        assert_plain(&text);
        assert!(text.contains("俯拍近景的食物"), "{text}");
        assert!(text.contains("吃喝"), "{text}");
        assert!(text.contains("手持拍摄"), "{text}");
        assert!(text.contains("城南面馆"), "{text}");
        assert!(text.contains("这家的面真不错"), "{text}");
    }

    #[test]
    fn motion_only_still_reads_like_chinese() {
        let facts = facts_with(&[], Some("pan"), &[], None);
        let text = render(&facts);
        assert_plain(&text);
        assert_eq!(text, "横摇拍摄。");
    }

    #[test]
    fn nothing_at_all_says_what_to_do_next() {
        let text = render(&BriefFacts::default());
        assert_plain(&text);
        assert!(text.contains("先跑一次分析"), "{text}");
    }

    #[test]
    fn low_confidence_labels_are_dropped_by_collect() {
        // render 只看已过滤的表;这里守住阈值常量本身不被调高到把可靠标签也吃掉,
        // 也不被调到 0(那样噪声标签会一路进 prompt)。
        let score = MIN_LABEL_SCORE;
        assert!(score > 0.0, "阈值不能是 0,否则噪声标签也算数:{score}");
        assert!(score < 0.5, "阈值过高会把可靠标签也吃掉:{score}");
    }

    #[test]
    fn long_speech_is_truncated() {
        let long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
        assert_eq!(truncate_chars(long, 5).chars().count(), 6, "截断后要带省略号");
    }
}
