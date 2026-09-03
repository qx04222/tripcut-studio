use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::error::{CoreError, Result};

const MAX_CLOCK_OFFSET_MS: i64 = 14 * 60 * 60 * 1_000;
const GPS_MATCH_KM: f64 = 0.25;
const OFFSET_CLUSTER_MS: i64 = 2 * 60 * 1_000;
const INTERVAL_MATCH_MS: i64 = 30 * 1_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DeviceClockSetting {
    pub device_model: String,
    pub clip_count: i64,
    pub journey_offset_ms: i64,
    pub source: String,
    pub confidence: Option<f64>,
    pub timezone_conflicts: i64,
    pub needs_review: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProxyTimePoint {
    pub proxy_ts_ms: i64,
    pub source_ticks: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VfrTimePoint {
    pub frame_index: i64,
    pub source_ticks: i64,
}

#[derive(Debug, Clone)]
pub struct ProxyTimeMapper {
    tb_num: i64,
    tb_den: i64,
    points: Vec<ProxyTimePoint>,
}

impl ProxyTimeMapper {
    pub fn from_points(tb_num: i64, tb_den: i64, points: Vec<ProxyTimePoint>) -> Option<Self> {
        let valid = tb_num > 0
            && tb_den > 0
            && points.len() >= 2
            && points.windows(2).all(|pair| {
                pair[0].proxy_ts_ms < pair[1].proxy_ts_ms
                    && pair[0].source_ticks <= pair[1].source_ticks
            });
        valid.then_some(Self {
            tb_num,
            tb_den,
            points,
        })
    }

    pub fn source_seconds_for_proxy_seconds(&self, proxy_seconds: f64) -> f64 {
        let proxy_ms = proxy_seconds.max(0.0) * 1_000.0;
        let ticks = self.source_ticks_for_proxy_ms(proxy_ms);
        ticks * self.tb_num as f64 / self.tb_den as f64
    }

    pub fn proxy_seconds_for_source_seconds(&self, source_seconds: f64) -> f64 {
        let ticks = source_seconds.max(0.0) * self.tb_den as f64 / self.tb_num as f64;
        self.proxy_ms_for_source_ticks(ticks) / 1_000.0
    }

    pub fn source_duration_seconds(&self) -> f64 {
        self.points
            .last()
            .map(|point| point.source_ticks as f64 * self.tb_num as f64 / self.tb_den as f64)
            .unwrap_or(0.0)
    }

    fn source_ticks_for_proxy_ms(&self, proxy_ms: f64) -> f64 {
        interpolate(
            proxy_ms,
            &self.points,
            |point| point.proxy_ts_ms as f64,
            |point| point.source_ticks as f64,
        )
    }

    fn proxy_ms_for_source_ticks(&self, source_ticks: f64) -> f64 {
        interpolate(
            source_ticks,
            &self.points,
            |point| point.source_ticks as f64,
            |point| point.proxy_ts_ms as f64,
        )
    }
}

fn interpolate(
    value: f64,
    points: &[ProxyTimePoint],
    x: impl Fn(&ProxyTimePoint) -> f64,
    y: impl Fn(&ProxyTimePoint) -> f64,
) -> f64 {
    let first = &points[0];
    if value <= x(first) {
        return y(first);
    }
    let last = &points[points.len() - 1];
    if value >= x(last) {
        return y(last);
    }
    let upper = points
        .partition_point(|point| x(point) < value)
        .min(points.len() - 1);
    let left = &points[upper - 1];
    let right = &points[upper];
    let x0 = x(left);
    let x1 = x(right);
    if x1 <= x0 {
        return y(left);
    }
    y(left) + (value - x0) * (y(right) - y(left)) / (x1 - x0)
}

pub fn build_linear_proxy_map(
    duration_ticks: i64,
    tb_num: i64,
    tb_den: i64,
    proxy_duration_ms: i64,
) -> Vec<ProxyTimePoint> {
    if duration_ticks <= 0 || tb_num <= 0 || tb_den <= 0 || proxy_duration_ms <= 0 {
        return Vec::new();
    }
    let mut timestamps = (0..=proxy_duration_ms / 1_000)
        .map(|second| second * 1_000)
        .collect::<Vec<_>>();
    if timestamps.last().copied() != Some(proxy_duration_ms) {
        timestamps.push(proxy_duration_ms);
    }
    timestamps
        .into_iter()
        .map(|proxy_ts_ms| ProxyTimePoint {
            proxy_ts_ms,
            source_ticks: if proxy_ts_ms == proxy_duration_ms {
                duration_ticks
            } else {
                (divide_round(
                    i128::from(proxy_ts_ms) * i128::from(tb_den),
                    1_000_i128 * i128::from(tb_num),
                ) as i64)
                    .clamp(0, duration_ticks)
            },
        })
        .collect()
}

pub fn build_identity_proxy_map(
    duration_ticks: i64,
    tb_num: i64,
    tb_den: i64,
) -> Vec<ProxyTimePoint> {
    if duration_ticks <= 0 || tb_num <= 0 || tb_den <= 0 {
        return Vec::new();
    }
    let duration_ms = divide_round(
        i128::from(duration_ticks) * i128::from(tb_num) * 1_000,
        i128::from(tb_den),
    )
    .max(1);
    let Ok(duration_ms) = i64::try_from(duration_ms) else {
        return Vec::new();
    };
    build_linear_proxy_map(duration_ticks, tb_num, tb_den, duration_ms)
}

pub fn sample_vfr_time_map(
    frame_ticks: &[i64],
    tb_num: i64,
    tb_den: i64,
) -> Vec<VfrTimePoint> {
    if tb_num <= 0 || tb_den <= 0 {
        return Vec::new();
    }
    let mut frames = Vec::new();
    for (index, source_ticks) in frame_ticks.iter().copied().enumerate() {
        if source_ticks < 0
            || frames
                .last()
                .is_some_and(|point: &VfrTimePoint| point.source_ticks >= source_ticks)
        {
            continue;
        }
        frames.push(VfrTimePoint {
            frame_index: index as i64,
            source_ticks,
        });
    }
    if frames.len() < 2 {
        return Vec::new();
    }

    let mut sampled = BTreeMap::new();
    let mut previous_second = None;
    for (position, point) in frames.iter().enumerate() {
        let second =
            i128::from(point.source_ticks) * i128::from(tb_num) / i128::from(tb_den);
        let cadence_changed = position >= 2 && {
            let previous_delta = frames[position - 1]
                .source_ticks
                .saturating_sub(frames[position - 2].source_ticks);
            let current_delta = point
                .source_ticks
                .saturating_sub(frames[position - 1].source_ticks);
            previous_delta.abs_diff(current_delta)
                > (previous_delta.unsigned_abs() / 10).max(1)
        };
        if position < 32
            || position + 1 == frames.len()
            || previous_second != Some(second)
            || cadence_changed
        {
            sampled.insert(point.frame_index, *point);
        }
        previous_second = Some(second);
    }
    sampled.into_values().collect()
}

pub fn frame_timing_is_vfr(
    frame_ticks: &[i64],
    tb_num: i64,
    tb_den: i64,
    fps_num: i64,
    fps_den: i64,
) -> bool {
    if frame_ticks.len() < 3
        || tb_num <= 0
        || tb_den <= 0
        || fps_num <= 0
        || fps_den <= 0
    {
        return false;
    }
    let expected = tb_den as f64 * fps_den as f64 / (tb_num as f64 * fps_num as f64);
    let tolerance = (expected * 0.05).max(2.0);
    frame_ticks.windows(2).any(|pair| {
        let delta = pair[1].saturating_sub(pair[0]);
        delta <= 0 || (delta as f64 - expected).abs() > tolerance
    })
}

pub fn replace_vfr_map(
    connection: &Connection,
    clip_id: i64,
    points: &[VfrTimePoint],
) -> Result<()> {
    connection.execute("DELETE FROM vfr_time_map WHERE clip_id = ?1", [clip_id])?;
    for (sample_index, point) in points.iter().enumerate() {
        connection.execute(
            "INSERT INTO vfr_time_map(clip_id, sample_index, frame_index, source_ticks)
             VALUES (?1, ?2, ?3, ?4)",
            params![clip_id, sample_index as i64, point.frame_index, point.source_ticks],
        )?;
    }
    Ok(())
}

pub fn load_vfr_source_pts_us(connection: &Connection, clip_id: i64) -> Result<Vec<i64>> {
    let (tb_num, tb_den) = connection
        .query_row(
            "SELECT tb_num, tb_den FROM clips WHERE id = ?1",
            [clip_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::Import(format!("素材 {clip_id} 不存在")))?;
    let mut statement = connection.prepare(
        "SELECT source_ticks FROM vfr_time_map
         WHERE clip_id = ?1 ORDER BY sample_index",
    )?;
    let ticks = statement
        .query_map([clip_id], |row| row.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ticks
        .into_iter()
        .map(|ticks| {
            ticks_to_micros(ticks, tb_num, tb_den).ok_or_else(|| {
                CoreError::Import(format!("素材 {clip_id} 的 VFR 时间采样无效"))
            })
        })
        .collect()
}

pub fn ticks_to_micros(ticks: i64, tb_num: i64, tb_den: i64) -> Option<i64> {
    if tb_num <= 0 || tb_den <= 0 {
        return None;
    }
    let value = divide_round(
        i128::from(ticks) * i128::from(tb_num) * 1_000_000,
        i128::from(tb_den),
    );
    i64::try_from(value).ok()
}

fn divide_round(numerator: i128, denominator: i128) -> i128 {
    if numerator >= 0 {
        (numerator + denominator / 2) / denominator
    } else {
        (numerator - denominator / 2) / denominator
    }
}

pub fn replace_proxy_map(
    connection: &mut Connection,
    clip_id: i64,
    points: &[ProxyTimePoint],
) -> Result<()> {
    if points.len() < 2 {
        return Err(CoreError::Artifact(format!(
            "素材 {clip_id} 的代理时间映射点不足"
        )));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute("DELETE FROM proxy_time_map WHERE clip_id = ?1", [clip_id])?;
    for point in points {
        transaction.execute(
            "INSERT INTO proxy_time_map(clip_id, proxy_ts_ms, source_ticks)
             VALUES (?1, ?2, ?3)",
            params![clip_id, point.proxy_ts_ms, point.source_ticks],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub fn load_proxy_mapper(connection: &Connection, clip_id: i64) -> Result<Option<ProxyTimeMapper>> {
    let time_base = connection
        .query_row(
            "SELECT tb_num, tb_den FROM clips WHERE id = ?1",
            [clip_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((tb_num, tb_den)) = time_base else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT proxy_ts_ms, source_ticks FROM proxy_time_map
         WHERE clip_id = ?1 ORDER BY proxy_ts_ms",
    )?;
    let points = statement
        .query_map([clip_id], |row| {
            Ok(ProxyTimePoint {
                proxy_ts_ms: row.get(0)?,
                source_ticks: row.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ProxyTimeMapper::from_points(tb_num, tb_den, points))
}

pub fn list_device_clocks(connection: &Connection) -> Result<Vec<DeviceClockSetting>> {
    let mut statement = connection.prepare(
        "SELECT device_model, COUNT(*),
                CAST(ROUND(AVG(journey_offset_ms)) AS INTEGER),
                CASE
                  WHEN SUM(journey_offset_source = 'manual') > 0 THEN 'manual'
                  WHEN SUM(journey_offset_source = 'auto') > 0 THEN 'auto'
                  WHEN SUM(journey_offset_source = 'reference') > 0 THEN 'reference'
                  ELSE 'unset'
                END,
                MAX(journey_offset_confidence), SUM(tz_conflict)
         FROM clips
         WHERE missing_since IS NULL
           AND device_model IS NOT NULL AND trim(device_model) != ''
         GROUP BY device_model
         ORDER BY device_model COLLATE NOCASE",
    )?;
    let rows = statement.query_map([], |row| {
        let source: String = row.get(3)?;
        let confidence: Option<f64> = row.get(4)?;
        Ok(DeviceClockSetting {
            device_model: row.get(0)?,
            clip_count: row.get(1)?,
            journey_offset_ms: row.get(2)?,
            needs_review: source == "unset"
                || (source == "auto" && confidence.unwrap_or(0.0) < 0.70),
            source,
            confidence,
            timezone_conflicts: row.get(5)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)
}

pub fn set_device_offset(
    connection: &mut Connection,
    device_model: &str,
    offset_ms: i64,
) -> Result<()> {
    let device_model = device_model.trim();
    if device_model.is_empty() {
        return Err(CoreError::Story("设备型号不能为空".to_owned()));
    }
    if offset_ms.unsigned_abs() > MAX_CLOCK_OFFSET_MS as u64 {
        return Err(CoreError::Story("设备时钟偏移不能超过正负 14 小时".to_owned()));
    }
    let changed = connection.execute(
        "UPDATE clips
         SET journey_offset_ms = ?2,
             journey_offset_source = 'manual',
             journey_offset_confidence = 1.0
         WHERE device_model = ?1 AND missing_since IS NULL",
        params![device_model, offset_ms],
    )?;
    if changed == 0 {
        return Err(CoreError::Story(format!("没有找到设备 {device_model} 的素材")));
    }
    super::story::chapterize(connection)?;
    super::shot_stack::rebuild(connection)?;
    Ok(())
}

pub fn enqueue_align_if_ready(connection: &mut Connection) -> Result<Option<i64>> {
    let active_dependencies: i64 = connection.query_row(
        "SELECT COUNT(*) FROM jobs
         WHERE kind IN ('import_probe', 'metadata_backfill')
           AND status IN ('pending', 'running')",
        [],
        |row| row.get(0),
    )?;
    if active_dependencies > 0 {
        return Ok(None);
    }
    let snapshot: (i64, i64, i64, String) = connection.query_row(
        "SELECT COUNT(*), COUNT(DISTINCT device_model),
                COALESCE(SUM(length(COALESCE(device_model, ''))), 0),
                COALESCE(MAX(imported_at), '')
         FROM clips WHERE missing_since IS NULL",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    if snapshot.0 == 0 {
        return Ok(None);
    }
    let payload_hash = format!(
        "align_clocks:{}:{}:{}:{}",
        snapshot.0, snapshot.1, snapshot.2, snapshot.3
    );
    if connection
        .query_row(
            "SELECT id FROM jobs WHERE kind = 'align_clocks' AND payload_hash = ?1",
            [&payload_hash],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some()
    {
        return Ok(None);
    }
    connection.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            'align_clocks', '{}', ?1, 'pending', 0,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )",
        [&payload_hash],
    )?;
    Ok(Some(connection.last_insert_rowid()))
}

#[derive(Debug, Clone)]
struct ClockMoment {
    epoch_ms: i64,
    latitude: f64,
    longitude: f64,
}

#[derive(Debug, Clone)]
struct DeviceMoments {
    model: String,
    moments: Vec<ClockMoment>,
    clip_count: usize,
    manual_offset_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ClockEstimate {
    offset_ms: i64,
    confidence: f64,
    gps_matches: usize,
    interval_matches: usize,
    high_confidence: bool,
}

pub fn align_clocks(connection: &mut Connection) -> Result<usize> {
    let devices = load_device_moments(connection)?;
    let Some(reference) = devices.iter().max_by(|left, right| {
        (left.moments.len(), left.clip_count, &left.model)
            .cmp(&(right.moments.len(), right.clip_count, &right.model))
    }) else {
        return Ok(0);
    };
    let reference_offset = reference.manual_offset_ms.unwrap_or(0);
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut changed = 0;
    if reference.manual_offset_ms.is_none() {
        changed += transaction.execute(
            "UPDATE clips SET journey_offset_ms = 0,
                 journey_offset_source = 'reference', journey_offset_confidence = 1.0
             WHERE device_model = ?1 AND journey_offset_source != 'manual'",
            [&reference.model],
        )?;
    }
    for device in &devices {
        if device.model == reference.model || device.manual_offset_ms.is_some() {
            continue;
        }
        let Some(estimate) = estimate_offset(reference, device, reference_offset) else {
            continue;
        };
        if !estimate.high_confidence {
            continue;
        }
        changed += transaction.execute(
            "UPDATE clips
             SET journey_offset_ms = ?2, journey_offset_source = 'auto',
                 journey_offset_confidence = ?3
             WHERE device_model = ?1 AND journey_offset_source != 'manual'",
            params![device.model, estimate.offset_ms, estimate.confidence],
        )?;
    }
    transaction.commit()?;
    if changed > 0 {
        super::story::chapterize(connection)?;
        super::shot_stack::rebuild(connection)?;
    }
    Ok(changed)
}

fn load_device_moments(connection: &Connection) -> Result<Vec<DeviceMoments>> {
    let mut groups: BTreeMap<String, DeviceMoments> = BTreeMap::new();
    let mut statement = connection.prepare(
        "SELECT device_model,
                CAST(strftime('%s', captured_at) AS INTEGER) * 1000,
                gps_lat, gps_lon, journey_offset_ms, journey_offset_source
         FROM clips
         WHERE missing_since IS NULL
           AND device_model IS NOT NULL AND trim(device_model) != ''
           AND captured_at IS NOT NULL
           AND strftime('%s', captured_at) IS NOT NULL
         ORDER BY device_model, captured_at, id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<f64>>(2)?,
            row.get::<_, Option<f64>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    for row in rows {
        let (model, epoch_ms, latitude, longitude, offset_ms, source) = row?;
        let group = groups.entry(model.clone()).or_insert_with(|| DeviceMoments {
            model,
            moments: Vec::new(),
            clip_count: 0,
            manual_offset_ms: None,
        });
        group.clip_count += 1;
        if source == "manual" {
            group.manual_offset_ms = Some(offset_ms);
        }
        if let (Some(latitude), Some(longitude)) = (latitude, longitude) {
            if latitude.is_finite()
                && longitude.is_finite()
                && (-90.0..=90.0).contains(&latitude)
                && (-180.0..=180.0).contains(&longitude)
            {
                group.moments.push(ClockMoment {
                    epoch_ms,
                    latitude,
                    longitude,
                });
            }
        }
    }
    Ok(groups.into_values().collect())
}

fn estimate_offset(
    reference: &DeviceMoments,
    candidate: &DeviceMoments,
    reference_offset_ms: i64,
) -> Option<ClockEstimate> {
    let mut matches = candidate
        .moments
        .iter()
        .filter_map(|candidate_moment| {
            let reference_moment = reference.moments.iter().min_by(|left, right| {
                distance_km(left, candidate_moment)
                    .total_cmp(&distance_km(right, candidate_moment))
            })?;
            (distance_km(reference_moment, candidate_moment) <= GPS_MATCH_KM).then_some((
                candidate_moment.epoch_ms,
                reference_moment.epoch_ms,
                reference_moment.epoch_ms + reference_offset_ms - candidate_moment.epoch_ms,
            ))
        })
        .filter(|(_, _, offset)| offset.abs() <= MAX_CLOCK_OFFSET_MS)
        .collect::<Vec<_>>();
    if matches.len() < 2 {
        return None;
    }

    matches.sort_by_key(|entry| entry.2);
    let mut best = (0, 1);
    let mut start = 0;
    for end in 0..matches.len() {
        while matches[end].2 - matches[start].2 > OFFSET_CLUSTER_MS {
            start += 1;
        }
        if end + 1 - start > best.1 - best.0 {
            best = (start, end + 1);
        }
    }
    let mut dominant = matches[best.0..best.1].to_vec();
    if dominant.len() < 2 {
        return None;
    }
    let offset_ms = dominant[dominant.len() / 2].2;
    dominant.sort_by_key(|entry| entry.0);
    let interval_matches = dominant
        .windows(2)
        .filter(|pair| {
            let candidate_gap = pair[1].0 - pair[0].0;
            let reference_gap = pair[1].1 - pair[0].1;
            candidate_gap > 0
                && reference_gap > 0
                && (candidate_gap - reference_gap).abs() <= INTERVAL_MATCH_MS
        })
        .count();
    let mut deviations = dominant
        .iter()
        .map(|entry| (entry.2 - offset_ms).abs())
        .collect::<Vec<_>>();
    deviations.sort_unstable();
    let median_deviation = deviations[deviations.len() / 2];
    let support_score = (dominant.len() as f64 / 4.0).min(1.0);
    let interval_score = (interval_matches as f64 / 2.0).min(1.0);
    let dispersion_score =
        (1.0 - median_deviation as f64 / OFFSET_CLUSTER_MS as f64).clamp(0.0, 1.0);
    let confidence = 0.45 * support_score + 0.35 * interval_score + 0.20 * dispersion_score;
    Some(ClockEstimate {
        offset_ms,
        confidence,
        gps_matches: dominant.len(),
        interval_matches,
        high_confidence: dominant.len() >= 3
            && interval_matches >= 1
            && median_deviation <= 30_000
            && confidence >= 0.70,
    })
}

fn distance_km(left: &ClockMoment, right: &ClockMoment) -> f64 {
    let radius_km = 6_371.0;
    let latitude_delta = (right.latitude - left.latitude).to_radians();
    let longitude_delta = (right.longitude - left.longitude).to_radians();
    let left_latitude = left.latitude.to_radians();
    let right_latitude = right.latitude.to_radians();
    let haversine = (latitude_delta / 2.0).sin().powi(2)
        + left_latitude.cos()
            * right_latitude.cos()
            * (longitude_delta / 2.0).sin().powi(2);
    radius_km * 2.0 * haversine.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn device(model: &str, offset_ms: i64, points: &[(i64, f64, f64)]) -> DeviceMoments {
        DeviceMoments {
            model: model.to_owned(),
            moments: points
                .iter()
                .map(|(epoch_ms, latitude, longitude)| ClockMoment {
                    epoch_ms: *epoch_ms,
                    latitude: *latitude,
                    longitude: *longitude,
                })
                .collect(),
            clip_count: points.len(),
            manual_offset_ms: (offset_ms != 0).then_some(offset_ms),
        }
    }

    #[test]
    fn proxy_map_contains_first_each_second_and_exact_last() {
        let points = build_linear_proxy_map(270_270, 1, 90_000, 3_003);
        assert_eq!(points.first().copied(), Some(ProxyTimePoint { proxy_ts_ms: 0, source_ticks: 0 }));
        assert_eq!(points.last().copied(), Some(ProxyTimePoint { proxy_ts_ms: 3_003, source_ticks: 270_270 }));
        assert_eq!(points.iter().map(|point| point.proxy_ts_ms).collect::<Vec<_>>(), vec![0, 1_000, 2_000, 3_000, 3_003]);
    }

    #[test]
    fn proxy_source_round_trip_stays_within_one_source_tick() {
        let mapper = ProxyTimeMapper::from_points(
            1,
            90_000,
            build_linear_proxy_map(900_000, 1, 90_000, 10_011),
        ).unwrap();
        for source_tick in (0..=900_000).step_by(997) {
            let source_seconds = source_tick as f64 / 90_000.0;
            let proxy_seconds = mapper.proxy_seconds_for_source_seconds(source_seconds);
            let round_trip_ticks = mapper.source_seconds_for_proxy_seconds(proxy_seconds) * 90_000.0;
            assert!((round_trip_ticks.round() as i64 - source_tick).abs() <= 1);
        }
    }

    #[test]
    fn direct_proxy_map_is_an_identity_at_whole_seconds_and_exact_end() {
        let points = build_identity_proxy_map(270_270, 1, 90_000);

        assert_eq!(points.first(), Some(&ProxyTimePoint { proxy_ts_ms: 0, source_ticks: 0 }));
        assert_eq!(points.last(), Some(&ProxyTimePoint { proxy_ts_ms: 3_003, source_ticks: 270_270 }));
        assert_eq!(points[1], ProxyTimePoint { proxy_ts_ms: 1_000, source_ticks: 90_000 });
    }

    #[test]
    fn vfr_sampling_keeps_early_frames_second_boundaries_cadence_changes_and_end() {
        let mut ticks = (0..70).map(|index| index * 3_003).collect::<Vec<_>>();
        ticks[40] += 3_003;
        for tick in ticks.iter_mut().skip(41) {
            *tick += 3_003;
        }

        let points = sample_vfr_time_map(&ticks, 1, 90_000);

        assert!(points.iter().any(|point| point.frame_index == 1));
        assert!(points.iter().any(|point| point.frame_index == 30));
        assert!(points.iter().any(|point| point.frame_index == 40));
        assert_eq!(points.last().map(|point| point.frame_index), Some(69));
    }

    #[test]
    fn irregular_frame_intervals_are_detected_from_pts_not_average_rate_metadata() {
        let ticks = [0, 3_003, 6_006, 12_012, 15_015];

        assert!(frame_timing_is_vfr(&ticks, 1, 90_000, 30_000, 1_001));
        assert!(!frame_timing_is_vfr(&[0, 3_003, 6_006, 9_009], 1, 90_000, 30_000, 1_001));
    }

    #[test]
    fn clock_alignment_requires_gps_overlap_and_interval_support() {
        let reference = device("Drone", 0, &[
            (1_000_000, 43.0, -79.0),
            (1_060_000, 43.001, -79.001),
            (1_150_000, 43.002, -79.002),
            (1_240_000, 43.003, -79.003),
        ]);
        let candidate = device("Phone", 0, &[
            (880_000, 43.0, -79.0),
            (940_000, 43.001, -79.001),
            (1_030_000, 43.002, -79.002),
            (1_120_000, 43.003, -79.003),
        ]);
        let estimate = estimate_offset(&reference, &candidate, 0).unwrap();
        assert_eq!(estimate.offset_ms, 120_000);
        assert!(estimate.high_confidence);
    }

    #[test]
    fn low_confidence_clock_match_never_qualifies_for_auto_change() {
        let reference = device("Drone", 0, &[(1_000_000, 43.0, -79.0), (2_000_000, 43.0, -79.0)]);
        let candidate = device("Phone", 0, &[(500_000, 43.0, -79.0), (510_000, 43.0, -79.0)]);
        let estimate = estimate_offset(&reference, &candidate, 0).unwrap();
        assert!(!estimate.high_confidence);
    }

    #[test]
    fn align_job_leaves_low_confidence_devices_unmodified() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        for (path, captured_at, model) in [
            ("d1.mov", "2026-09-01T10:00:00Z", "Drone"),
            ("d2.mov", "2026-09-01T11:00:00Z", "Drone"),
            ("p1.mov", "2026-09-01T09:00:00Z", "Phone"),
            ("p2.mov", "2026-09-01T09:00:10Z", "Phone"),
        ] {
            connection.execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, captured_at, gps_lat, gps_lon,
                    device_model, imported_at
                 ) VALUES ('v', ?1, ?2, 43.0, -79.0, ?3, 'now')",
                params![path, captured_at, model],
            ).unwrap();
        }

        align_clocks(&mut connection).unwrap();
        let automatic: i64 = connection.query_row(
            "SELECT COUNT(*) FROM clips WHERE journey_offset_source = 'auto'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(automatic, 0);
    }

    #[test]
    fn manual_offset_updates_the_device_without_rewriting_capture_time() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        connection.execute(
            "INSERT INTO clips(volume_uuid, rel_path, captured_at, device_model, imported_at)
             VALUES ('v', 'a.mov', '2026-09-01T12:00:00Z', 'Phone', 'now')",
            [],
        ).unwrap();
        set_device_offset(&mut connection, "Phone", -3_600_000).unwrap();
        let stored: (String, i64, String) = connection.query_row(
            "SELECT captured_at, journey_offset_ms, journey_offset_source FROM clips",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(stored, ("2026-09-01T12:00:00Z".to_owned(), -3_600_000, "manual".to_owned()));
    }
}
