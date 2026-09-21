//! R20:质量标签使用固定中文表;旧数组与新结构都可读,未知内部键不进入文案。
use serde::{Deserialize, Serialize};
use super::super::moments::Moment;

pub const FIXABLE: [(&str, &str); 5] = [
    ("exposure_bright", "曝光偏亮"), ("exposure_dark", "曝光偏暗"),
    ("slight_shake", "轻微手抖"), ("bystander", "路人入镜"), ("color_cast", "色偏"),
];
pub const BLOCKERS: [(&str, &str); 4] = [
    ("defocus", "失焦"), ("excessive_shake", "抖动过大"),
    ("bad_timing", "时机差"), ("high_contrast", "大光比"),
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Reason {
    pub reasons: Vec<String>,
    pub fixable: Vec<String>,
    pub blockers: Vec<String>,
}

fn labels(values: &[String], table: &[(&str, &str)]) -> Vec<String> {
    table.iter().filter(|(key, label)| values.iter().any(|v| v == key || v == label))
        .map(|(_, label)| (*label).to_owned()).collect()
}

impl Reason {
    pub fn from_labels(values: &[String]) -> Self {
        Self { reasons: Vec::new(), fixable: labels(values, &FIXABLE), blockers: labels(values, &BLOCKERS) }
    }
    pub fn from_moments(moments: &[Moment]) -> Self {
        Self::from_labels(&moments.iter().flat_map(|m| m.reasons.clone()).collect::<Vec<_>>())
    }
    pub fn read(json: &str) -> Self {
        if let Ok(reasons) = serde_json::from_str::<Vec<String>>(json) {
            return Self { reasons, ..Self::default() };
        }
        let mut value = serde_json::from_str::<Self>(json).unwrap_or_default();
        value.fixable = labels(&value.fixable, &FIXABLE);
        value.blockers = labels(&value.blockers, &BLOCKERS);
        value
    }
    pub fn display(&self) -> Vec<String> {
        let mut out = self.reasons.clone();
        if !self.fixable.is_empty() { out.push(format!("可修:{}", self.fixable.join("、"))); }
        if !self.blockers.is_empty() { out.push(format!("未选:{}", self.blockers.join("、"))); }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Unselected {
    pub clip_id: i64,
    pub blockers: Vec<String>,
}


pub fn has_blocker(moments: &[Moment]) -> bool {
    moments.iter().any(|moment| moment.reasons.iter().any(|value|
        BLOCKERS.iter().any(|(key, label)| value == key || value == label)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_reasons_and_new_quality_labels_are_readable() {
        assert_eq!(Reason::read(r#"["清晰"]"#).display(), vec!["清晰"]);
        let json = r#"{"reasons":["清晰"],"fixable":["exposure_dark","bystander","internal_unknown"],"blockers":["high_contrast"]}"#;
        let reason = Reason::read(json);
        assert_eq!(reason.fixable, vec!["曝光偏暗", "路人入镜"]);
        assert_eq!(reason.blockers, vec!["大光比"]);
        assert_eq!(reason.display(), vec!["清晰", "可修:曝光偏暗、路人入镜", "未选:大光比"]);
    }
}
