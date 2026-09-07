use std::path::Path;

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::Result;

/// 一路 ffprobe 探测到的音频流，`stream_index` 是音频相对序号
/// （即 `-map 0:a:N` 里的 N，而不是容器里的绝对 stream index）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioStreamProbe {
    pub stream_index: i64,
    pub channels: Option<i64>,
    pub channel_layout: Option<String>,
    pub sample_rate: Option<i64>,
    pub role_guess: String,
}

/// `clip_audio_tracks` 表的一行，供前端/命令层读取。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClipAudioTrack {
    pub clip_id: i64,
    pub stream_index: i64,
    pub channels: Option<i64>,
    pub channel_layout: Option<String>,
    pub sample_rate: Option<i64>,
    pub role_guess: Option<String>,
}

/// 从厂商标签里解析出的拍摄参数；任一项缺失就是 `None`。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CaptureTags {
    pub iso_value: Option<i64>,
    pub shutter_speed: Option<String>,
    pub aperture: Option<String>,
}

const ISO_KEYS: &[&str] = &["iso", "com.dji.iso", "com.apple.quicktime.camera.iso"];
const SHUTTER_KEYS: &[&str] = &["shutter", "shutterspeed", "exposure_time"];
const APERTURE_KEYS: &[&str] = &["aperture", "fnumber"];

/// 启发式：单声道 48k 且不是唯一一路 → 大概率是外接无线麦；
/// 第一路（index 0）立体声 → 机身自带麦；其余归为 unknown。
pub fn guess_role(index: usize, total: usize, channels: Option<i64>, sample_rate: Option<i64>) -> &'static str {
    let is_mono_48k = channels == Some(1) && sample_rate == Some(48_000);
    if is_mono_48k && total > 1 {
        "wireless_mic"
    } else if index == 0 && channels == Some(2) {
        "onboard_mic"
    } else {
        "unknown"
    }
}

/// 解析 ffprobe `streams` 数组里全部音频流（codec_type == "audio"），
/// 按容器里出现的顺序重新编号为音频相对序号。
pub fn parse_audio_streams(streams: &[Value]) -> Vec<AudioStreamProbe> {
    let audio_streams: Vec<&Value> = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .collect();
    let total = audio_streams.len();
    audio_streams
        .into_iter()
        .enumerate()
        .map(|(index, stream)| {
            let channels = stream_i64(stream, "channels");
            let sample_rate = stream_i64(stream, "sample_rate");
            let channel_layout = stream
                .get("channel_layout")
                .and_then(Value::as_str)
                .map(str::to_owned);
            AudioStreamProbe {
                stream_index: index as i64,
                channels,
                channel_layout,
                sample_rate,
                role_guess: guess_role(index, total, channels, sample_rate).to_owned(),
            }
        })
        .collect()
}

fn stream_i64(stream: &Value, key: &str) -> Option<i64> {
    stream.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
    })
}

/// 解析厂商 ISO 标签值。常见写法有 `ISO800`、`iso 1600`（大小写与空白不定）、
/// 以及部分导出器写成的浮点形式 `800.0`；`auto` 之类非数字值一律 `None`，
/// 不猜测。策略：剥掉大小写不敏感的前导 `iso` 与其后的空白，再取剩余部分
/// 开头连续的数字——浮点尾巴（`.0`）落在数字之后自然被舍弃，不需要单独处理。
fn parse_iso_value(value: &str) -> Option<i64> {
    let mut text = value.trim();
    if text.len() >= 3 && text[..3].eq_ignore_ascii_case("iso") {
        text = text[3..].trim_start();
    }
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok()
}

fn find_tag(tags: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        tags.iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
            .and_then(|(_, value)| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| value.as_i64().map(|number| number.to_string()))
            })
    })
}

/// 从 ffprobe 输出（`format.tags` 与各 `streams[].tags`）里搜集厂商拍摄参数标签。
/// `format.tags` 优先于 stream tags；缺失一律是 `None`，不猜测。
pub fn parse_capture_tags(value: &Value) -> CaptureTags {
    let mut merged = serde_json::Map::new();
    if let Some(format_tags) = value
        .get("format")
        .and_then(|format| format.get("tags"))
        .and_then(Value::as_object)
    {
        for (key, tag_value) in format_tags {
            merged.insert(key.clone(), tag_value.clone());
        }
    }
    if let Some(streams) = value.get("streams").and_then(Value::as_array) {
        for stream in streams {
            if let Some(tags) = stream.get("tags").and_then(Value::as_object) {
                for (key, tag_value) in tags {
                    merged.entry(key.clone()).or_insert_with(|| tag_value.clone());
                }
            }
        }
    }
    let iso_value = find_tag(&merged, ISO_KEYS).and_then(|value| parse_iso_value(&value));
    let shutter_speed = find_tag(&merged, SHUTTER_KEYS);
    let aperture = find_tag(&merged, APERTURE_KEYS);
    CaptureTags {
        iso_value,
        shutter_speed,
        aperture,
    }
}

/// 用最新探测结果整体替换某个素材的 `clip_audio_tracks` 行。
pub fn replace_for_clip(connection: &Connection, clip_id: i64, tracks: &[AudioStreamProbe]) -> Result<()> {
    connection.execute("DELETE FROM clip_audio_tracks WHERE clip_id = ?1", [clip_id])?;
    for track in tracks {
        connection.execute(
            "INSERT INTO clip_audio_tracks(clip_id, stream_index, channels, channel_layout, sample_rate, role_guess)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                clip_id,
                track.stream_index,
                track.channels,
                track.channel_layout,
                track.sample_rate,
                track.role_guess,
            ],
        )?;
    }
    Ok(())
}

pub fn list_for_clip(connection: &Connection, clip_id: i64) -> Result<Vec<ClipAudioTrack>> {
    let mut statement = connection.prepare(
        "SELECT clip_id, stream_index, channels, channel_layout, sample_rate, role_guess
         FROM clip_audio_tracks WHERE clip_id = ?1 ORDER BY stream_index",
    )?;
    let rows = statement.query_map([clip_id], |row| {
        Ok(ClipAudioTrack {
            clip_id: row.get(0)?,
            stream_index: row.get(1)?,
            channels: row.get(2)?,
            channel_layout: row.get(3)?,
            sample_rate: row.get(4)?,
            role_guess: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn probe_metadata_for_path(connection: &Connection, path: &Path) -> Result<super::import::ProbeMetadata> {
    let ffprobe = super::settings::configured_executable(
        connection,
        super::settings::FFPROBE_PATH_KEY,
        "FFPROBE_PATH",
        "ffprobe",
    )?;
    super::import::probe_media_with(path, &ffprobe, super::import::FFPROBE_TIMEOUT)
}

/// `enqueue_missing` 风格的补探测命令：对一个已导入的素材重新跑 ffprobe，
/// 落地它全部音频流与拍摄参数标签。用于导入之后新增音轨解析逻辑时的历史素材回填,
/// 或是用户手动触发的“重新探测音轨”。
pub fn probe_and_store(connection: &mut Connection, clip_id: i64) -> Result<Vec<ClipAudioTrack>> {
    let path = super::media_source::verified_clip_path(connection, clip_id)?;
    let metadata = probe_metadata_for_path(connection, &path)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    replace_for_clip(&transaction, clip_id, &metadata.audio_tracks)?;
    transaction.execute(
        "UPDATE clips SET iso_value = ?2, shutter_speed = ?3, aperture = ?4, audio_probed = 1 WHERE id = ?1",
        params![clip_id, metadata.iso_value, metadata.shutter_speed, metadata.aperture],
    )?;
    transaction.commit()?;
    list_for_clip(connection, clip_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn two_stream_dji_json() -> Value {
        json!({
            "format": {
                "tags": { "com.dji.iso": "800" }
            },
            "streams": [
                { "codec_type": "video" },
                {
                    "codec_type": "audio",
                    "channels": 2,
                    "channel_layout": "stereo",
                    "sample_rate": "48000"
                },
                {
                    "codec_type": "audio",
                    "channels": 1,
                    "channel_layout": "mono",
                    "sample_rate": "48000"
                }
            ]
        })
    }

    fn no_tags_json() -> Value {
        json!({
            "format": {},
            "streams": [
                { "codec_type": "video" },
                {
                    "codec_type": "audio",
                    "channels": 2,
                    "channel_layout": "stereo",
                    "sample_rate": "44100"
                }
            ]
        })
    }

    #[test]
    fn parses_two_audio_streams_with_relative_index() {
        let value = two_stream_dji_json();
        let streams = value.get("streams").and_then(Value::as_array).unwrap();
        let tracks = parse_audio_streams(streams);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].stream_index, 0);
        assert_eq!(tracks[0].channels, Some(2));
        assert_eq!(tracks[0].role_guess, "onboard_mic");
        assert_eq!(tracks[1].stream_index, 1);
        assert_eq!(tracks[1].channels, Some(1));
        assert_eq!(tracks[1].role_guess, "wireless_mic");
    }

    #[test]
    fn parses_dji_iso_tag_from_format_tags() {
        let tags = parse_capture_tags(&two_stream_dji_json());
        assert_eq!(tags.iso_value, Some(800));
        assert_eq!(tags.shutter_speed, None);
        assert_eq!(tags.aperture, None);
    }

    fn iso_tag_json(iso: &str) -> Value {
        json!({
            "format": { "tags": { "iso": iso } },
            "streams": [{ "codec_type": "video" }]
        })
    }

    #[test]
    fn iso_tag_with_iso_prefix_strips_it() {
        assert_eq!(parse_capture_tags(&iso_tag_json("ISO800")).iso_value, Some(800));
    }

    #[test]
    fn iso_tag_with_iso_prefix_and_space_strips_it() {
        assert_eq!(parse_capture_tags(&iso_tag_json("iso 1600")).iso_value, Some(1600));
    }

    #[test]
    fn iso_tag_with_decimal_suffix_truncates_it() {
        assert_eq!(parse_capture_tags(&iso_tag_json("800.0")).iso_value, Some(800));
    }

    #[test]
    fn iso_tag_with_non_numeric_value_is_none() {
        assert_eq!(parse_capture_tags(&iso_tag_json("auto")).iso_value, None);
    }

    #[test]
    fn missing_tags_are_all_none() {
        let tags = parse_capture_tags(&no_tags_json());
        assert_eq!(tags, CaptureTags::default());
    }

    #[test]
    fn single_stream_file_has_no_audio_tracks() {
        let value = no_tags_json();
        let streams = value.get("streams").and_then(Value::as_array).unwrap();
        let tracks = parse_audio_streams(streams);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].role_guess, "onboard_mic");
    }

    #[test]
    fn role_guess_heuristic_matches_spec() {
        // 单声道 48k 且第二路存在 → wireless_mic。
        assert_eq!(guess_role(1, 2, Some(1), Some(48_000)), "wireless_mic");
        // 单声道 48k 但是唯一一路，没有"第二路" → 不算 wireless_mic。
        assert_eq!(guess_role(0, 1, Some(1), Some(48_000)), "unknown");
        // 第一路立体声 → onboard_mic。
        assert_eq!(guess_role(0, 1, Some(2), Some(48_000)), "onboard_mic");
        assert_eq!(guess_role(0, 2, Some(2), Some(44_100)), "onboard_mic");
        // 其余情况 → unknown。
        assert_eq!(guess_role(1, 2, Some(2), Some(44_100)), "unknown");
    }
}
