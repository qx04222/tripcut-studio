//! R19 P-06:可审计的模型清单。首启 / 设置页「一键安装」只能装这张表里的东西 ——
//! 每一项有下载地址、SHA-256、字节数和最低内存档,下载器(`model_download.rs`)拿这张表
//! 校验,不认任何别的来源。
//!
//! 核对记录(2026-09-18,抓取自 Hugging Face):
//! - Chinese-CLIP `OFA-Sys/chinese-clip-vit-base-patch16`,仓库提交
//!   `36e679e65c2a2fead755ae21162091293ad37834`(2022-12-09)。URL 钉到这个提交,
//!   免得非 LFS 的三个小文件(config / preprocessor / vocab)被上游改动后摘要漂移。
//!   `pytorch_model.bin` 的 SHA-256 = LFS oid(`x-linked-etag`),三个小文件是下载后本机
//!   `shasum -a 256` 算的。`clip_service.py` 的 `from_pretrained(local_files_only=True)`
//!   只要这四个文件;`clip_cn_vit-b-16.pt` 是 OFA 原始格式,transformers 不读,不下。
//!   合计 ≈ 0.75 GB(旧文案里的「2.4 GB」是把 PyTorch 运行时也算进去了,这里只算模型)。
//! - whisper `ggerganov/whisper.cpp`:与 `transcribe::WHISPER_MODEL_SPECS` 同一份 URL / 摘要
//!   (2026-09-13 核对,2026-09-18 用 `x-linked-etag` 复核一致)。
//!
//! 落地位置:whisper 模型保持 `models/<file>`(转写器现有的解析路径,不动);CLIP 落到
//! `models/<id>/`,四个文件同目录,这个目录就是 `TRIPCUT_CLIP_MODEL_DIR` 的默认值。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::memory_profile::MemoryProfile;

/// 清单抓取日期(写进卡片「来源核对于」,也是审计线索)。
pub const CATALOG_FETCHED_ON: &str = "2026-09-18";

pub const CLIP_MODEL_ID: &str = "chinese-clip-vit-b-16";
pub const WHISPER_TURBO_MODEL_ID: &str = "whisper-large-v3-turbo";
pub const WHISPER_SMALL_MODEL_ID: &str = "whisper-small";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct ModelFile {
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModelKind {
    Clip,
    /// 转写模型;`tier` 对应 `tools.whisper_model_tier` 的取值。
    Whisper { tier: &'static str },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct ModelSpec {
    pub id: &'static str,
    pub title: &'static str,
    /// 一句白话:装了它能干什么。
    pub purpose: &'static str,
    pub kind: ModelKind,
    pub files: &'static [ModelFile],
    /// 最低内存档(`MemoryProfile::as_str`):`low_spec`(≤ 8 GB)/ `low`(16 GB)/ `standard`。
    pub min_memory_profile: &'static str,
}

const CLIP_FILES: [ModelFile; 4] = [
    ModelFile {
        name: "config.json",
        url: "https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/36e679e65c2a2fead755ae21162091293ad37834/config.json",
        sha256: "97850313ab34f4fdeed3a7886b4db8b209a842a48d1cbda079abd071d12c7a2f",
        size_bytes: 3_008,
    },
    ModelFile {
        name: "preprocessor_config.json",
        url: "https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/36e679e65c2a2fead755ae21162091293ad37834/preprocessor_config.json",
        sha256: "0e00af244b402c34f92898e2ba68359762ad3788e087b2a0e4d575512f388ea9",
        size_bytes: 342,
    },
    ModelFile {
        name: "vocab.txt",
        url: "https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/36e679e65c2a2fead755ae21162091293ad37834/vocab.txt",
        sha256: "45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c",
        size_bytes: 109_540,
    },
    ModelFile {
        name: "pytorch_model.bin",
        url: "https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/36e679e65c2a2fead755ae21162091293ad37834/pytorch_model.bin",
        sha256: "7b7b583c210c867410bc6bdb8a55fe14eec62999e0a9ea31ff222dc501f9cfbe",
        size_bytes: 753_177_983,
    },
];

const WHISPER_TURBO_FILES: [ModelFile; 1] = [ModelFile {
    name: "ggml-large-v3-turbo.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    size_bytes: 1_624_555_275,
}];

const WHISPER_SMALL_FILES: [ModelFile; 1] = [ModelFile {
    name: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    size_bytes: 487_601_967,
}];

pub const MODEL_CATALOG: [ModelSpec; 3] = [
    ModelSpec {
        id: CLIP_MODEL_ID,
        title: "画面理解模型",
        purpose: "看懂画面里有什么:按画面搜索、挑选时的「有意思」分、相似素材去重都靠它。",
        kind: ModelKind::Clip,
        files: &CLIP_FILES,
        // 侧车常驻 0.4–1 GB,LowSpec(≤ 8 GB)不起侧车(memory_profile::sidecars_enabled)。
        min_memory_profile: "low",
    },
    ModelSpec {
        id: WHISPER_TURBO_MODEL_ID,
        title: "转写模型(默认质量)",
        purpose: "把说话内容转成文字,搜索和字幕都用它;16 GB 及以上机器用这一档。",
        kind: ModelKind::Whisper { tier: super::transcribe::DEFAULT_MODEL_TIER },
        files: &WHISPER_TURBO_FILES,
        min_memory_profile: "low",
    },
    ModelSpec {
        id: WHISPER_SMALL_MODEL_ID,
        title: "转写模型(低内存)",
        purpose: "转写的省内存档:8 GB 机器用这一档,质量略低但不卡。",
        kind: ModelKind::Whisper { tier: super::transcribe::LOW_POWER_MODEL_TIER },
        files: &WHISPER_SMALL_FILES,
        min_memory_profile: "low_spec",
    },
];

pub fn spec_for_id(id: &str) -> Option<&'static ModelSpec> {
    MODEL_CATALOG.iter().find(|spec| spec.id == id)
}

impl ModelSpec {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size_bytes).sum()
    }

    /// 模型文件落在哪个目录:CLIP 是 `models/<id>/`,whisper 保持 `models/` 平铺。
    pub fn install_dir(&self, models_dir: &Path) -> PathBuf {
        match self.kind {
            ModelKind::Clip => models_dir.join(self.id),
            ModelKind::Whisper { .. } => models_dir.to_path_buf(),
        }
    }

    /// 已安装 = 每个文件都在且字节数精确相等(摘要在下载时校过;这里只做便宜的形状检查)。
    pub fn installed(&self, models_dir: &Path) -> bool {
        let dir = self.install_dir(models_dir);
        self.files.iter().all(|file| {
            std::fs::metadata(dir.join(file.name))
                .map(|meta| meta.is_file() && meta.len() == file.size_bytes)
                .unwrap_or(false)
        })
    }

    /// 这一档机器允不允许装(不允许时卡片只显示原因,不给「安装」)。
    pub fn allowed_on(&self, profile: MemoryProfile) -> bool {
        rank(profile.as_str()) >= rank(self.min_memory_profile)
    }

    /// 首启该推荐它吗:允许装、且是这一档的默认选择(转写只推荐当前档的那一个)。
    pub fn recommended_on(&self, profile: MemoryProfile) -> bool {
        if !self.allowed_on(profile) {
            return false;
        }
        match self.kind {
            ModelKind::Clip => profile.sidecars_enabled(),
            ModelKind::Whisper { tier } => tier == profile.default_whisper_tier(),
        }
    }
}

fn rank(profile: &str) -> u8 {
    match profile {
        "low_spec" => 0,
        "low" => 1,
        "standard" => 2,
        _ => 3,
    }
}

// ---------------------------------------------------------------------------
// CLIP 模型目录的解析:环境变量 > 设置覆盖 > 自动安装目录。
// ---------------------------------------------------------------------------

/// 设置页「画面理解模型位置」的覆盖值(`tools.clip_model_dir`),启动时与保存时由 lib.rs 灌入;
/// 侧车进程没有数据库连接,所以放一份在进程内。
static CLIP_DIR_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_clip_model_dir_override(value: Option<PathBuf>) {
    *CLIP_DIR_OVERRIDE.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = value;
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ProviderState {
    /// 没有模型:侧车起得来也算不出向量,`clip_embed` 任务会一路 blocked。
    Blocked { reason: String },
    Ready { dir: String, source: &'static str },
}

/// 纯函数版:`env_override` 是 `TRIPCUT_CLIP_MODEL_DIR`,`setting_override` 是设置里的覆盖。
pub fn clip_provider_state(
    models_dir: &Path,
    env_override: Option<&Path>,
    setting_override: Option<&Path>,
) -> ProviderState {
    for (candidate, source) in [(env_override, "env"), (setting_override, "setting")] {
        if let Some(dir) = candidate.filter(|dir| !dir.as_os_str().is_empty()) {
            return if dir.is_dir() {
                ProviderState::Ready { dir: dir.to_string_lossy().into_owned(), source }
            } else {
                ProviderState::Blocked { reason: format!("指定的画面理解模型目录不存在:{}", dir.display()) }
            };
        }
    }
    let spec = spec_for_id(CLIP_MODEL_ID).expect("catalog has the CLIP entry");
    if spec.installed(models_dir) {
        ProviderState::Ready {
            dir: spec.install_dir(models_dir).to_string_lossy().into_owned(),
            source: "catalog",
        }
    } else {
        ProviderState::Blocked { reason: "画面理解模型未安装".to_owned() }
    }
}

/// 进程级解析(侧车启动、设置状态都走这条):环境变量 > 设置覆盖 > `models/<id>/`。
pub fn resolve_clip_provider_state() -> ProviderState {
    let env_override = std::env::var_os("TRIPCUT_CLIP_MODEL_DIR").map(PathBuf::from);
    let setting_override = CLIP_DIR_OVERRIDE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let models_dir = super::provisioning::models_dir().unwrap_or_else(|_| PathBuf::from("models"));
    clip_provider_state(&models_dir, env_override.as_deref(), setting_override.as_deref())
}

pub fn resolve_clip_model_dir() -> Option<PathBuf> {
    match resolve_clip_provider_state() {
        ProviderState::Ready { dir, .. } => Some(PathBuf::from(dir)),
        ProviderState::Blocked { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::test_support::TestDirectory;

    #[test]
    fn every_catalog_entry_is_complete_and_https() {
        assert_eq!(MODEL_CATALOG.len(), 3);
        for spec in &MODEL_CATALOG {
            assert!(!spec.id.is_empty() && !spec.title.is_empty() && !spec.purpose.is_empty(), "{}", spec.id);
            assert!(!spec.files.is_empty(), "{} 没有文件", spec.id);
            assert!(matches!(spec.min_memory_profile, "low_spec" | "low" | "standard"), "{}", spec.id);
            for file in spec.files {
                assert!(file.url.starts_with("https://"), "{}/{} 不是 https:{}", spec.id, file.name, file.url);
                assert!(file.url.ends_with(file.name), "{}/{} URL 末尾应是文件名", spec.id, file.name);
                assert_eq!(file.sha256.len(), 64, "{}/{} 摘要长度", spec.id, file.name);
                assert!(file.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
                assert!(file.size_bytes > 0, "{}/{} 字节数", spec.id, file.name);
                assert!(!file.name.contains('/') && !file.name.contains(".."), "{}", file.name);
            }
        }
        assert_eq!(CATALOG_FETCHED_ON.len(), "2026-09-18".len());
    }

    #[test]
    fn whisper_entries_agree_with_the_transcriber_specs() {
        for whisper in crate::core::transcribe::WHISPER_MODEL_SPECS.iter() {
            let spec = MODEL_CATALOG
                .iter()
                .find(|spec| matches!(spec.kind, ModelKind::Whisper { tier } if tier == whisper.tier))
                .unwrap_or_else(|| panic!("清单缺 whisper {}", whisper.tier));
            assert_eq!(spec.files[0].url, whisper.download_url);
            assert_eq!(spec.files[0].sha256, whisper.expected_sha256);
            assert_eq!(spec.files[0].size_bytes, whisper.size_bytes);
            assert_eq!(spec.files[0].name, whisper.file_name);
        }
    }

    #[test]
    fn clip_entry_totals_the_four_transformers_files() {
        let clip = spec_for_id(CLIP_MODEL_ID).unwrap();
        let names: Vec<_> = clip.files.iter().map(|file| file.name).collect();
        assert_eq!(names, ["config.json", "preprocessor_config.json", "vocab.txt", "pytorch_model.bin"]);
        assert_eq!(clip.total_bytes(), 3_008 + 342 + 109_540 + 753_177_983);
    }

    #[test]
    fn memory_tier_gates_and_recommendations() {
        let clip = spec_for_id(CLIP_MODEL_ID).unwrap();
        let turbo = spec_for_id(WHISPER_TURBO_MODEL_ID).unwrap();
        let small = spec_for_id(WHISPER_SMALL_MODEL_ID).unwrap();
        // ≤ 8 GB:只推荐 small,CLIP 不允许。
        assert!(!clip.allowed_on(MemoryProfile::LowSpec));
        assert!(!clip.recommended_on(MemoryProfile::LowSpec));
        assert!(small.recommended_on(MemoryProfile::LowSpec));
        assert!(!turbo.recommended_on(MemoryProfile::LowSpec));
        // 16 GB 及以上:CLIP + turbo;small 允许但不推荐。
        for profile in [MemoryProfile::Low, MemoryProfile::Standard, MemoryProfile::HighPerf] {
            assert!(clip.recommended_on(profile), "{profile:?}");
            assert!(turbo.recommended_on(profile), "{profile:?}");
            assert!(small.allowed_on(profile) && !small.recommended_on(profile), "{profile:?}");
        }
    }

    #[test]
    fn installed_requires_every_file_at_its_exact_size() {
        let directory = TestDirectory::new();
        let models = directory.path().join("models");
        let clip = spec_for_id(CLIP_MODEL_ID).unwrap();
        assert!(!clip.installed(&models));
        let dir = clip.install_dir(&models);
        std::fs::create_dir_all(&dir).unwrap();
        for file in clip.files {
            std::fs::write(dir.join(file.name), vec![0_u8; file.size_bytes.min(4096) as usize]).unwrap();
        }
        assert!(!clip.installed(&models), "字节数不对不算已安装");
        let small = spec_for_id(WHISPER_SMALL_MODEL_ID).unwrap();
        assert_eq!(small.install_dir(&models), models, "whisper 保持 models/ 平铺");
    }

    #[test]
    fn clip_provider_state_goes_from_blocked_to_ready_when_the_model_dir_exists() {
        let directory = TestDirectory::new();
        let models = directory.path().join("models");
        assert!(matches!(clip_provider_state(&models, None, None), ProviderState::Blocked { .. }));
        // 环境变量指向不存在的目录:仍是 blocked,且原因说清。
        let missing = directory.path().join("nope");
        assert!(matches!(clip_provider_state(&models, Some(&missing), None), ProviderState::Blocked { .. }));
        // 环境变量指向存在的目录:ready(不检查目录内容,与 clip_service.py 的契约一致)。
        let env_dir = directory.path().join("env-model");
        std::fs::create_dir_all(&env_dir).unwrap();
        assert_eq!(
            clip_provider_state(&models, Some(&env_dir), None),
            ProviderState::Ready { dir: env_dir.to_string_lossy().into_owned(), source: "env" }
        );
        // 设置覆盖次之。
        assert!(matches!(clip_provider_state(&models, None, Some(&env_dir)), ProviderState::Ready { source: "setting", .. }));
        // 自动安装目录:四个文件按字节数就位 → ready(source = catalog)。
        let clip = spec_for_id(CLIP_MODEL_ID).unwrap();
        let dir = clip.install_dir(&models);
        std::fs::create_dir_all(&dir).unwrap();
        for file in clip.files {
            let file_handle = std::fs::File::create(dir.join(file.name)).unwrap();
            file_handle.set_len(file.size_bytes).unwrap();
        }
        assert_eq!(
            clip_provider_state(&models, None, None),
            ProviderState::Ready { dir: dir.to_string_lossy().into_owned(), source: "catalog" }
        );
    }

    /// 进程级解析要认设置覆盖(`tools.clip_model_dir` → `set_clip_model_dir_override`)。
    /// 不断言「覆盖前是 blocked」:那取决于这台机器真实的 models/ 目录与环境变量。
    #[test]
    fn process_level_resolution_honours_the_settings_override() {
        let directory = TestDirectory::new();
        let dir = directory.path().join("clip-from-settings");
        std::fs::create_dir_all(&dir).unwrap();
        set_clip_model_dir_override(Some(dir.clone()));
        let state = resolve_clip_provider_state();
        set_clip_model_dir_override(None);
        match state {
            ProviderState::Ready { dir: resolved, source: "setting" } => assert_eq!(resolved, dir.to_string_lossy()),
            ProviderState::Ready { source: "env", .. } => {} // 本机设了 TRIPCUT_CLIP_MODEL_DIR,环境变量优先
            other => panic!("设置覆盖指向存在的目录时必须 ready:{other:?}"),
        }
    }
}
