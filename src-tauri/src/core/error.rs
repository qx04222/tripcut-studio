use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("database schema version {found} is newer than supported version {supported}")]
    UnsupportedSchema { found: i64, supported: i64 },
    #[error("invalid database schema: {0}")]
    InvalidSchema(String),
    #[error("invalid job transition: {0}")]
    InvalidTransition(String),
    #[error("background task failed: {0}")]
    BackgroundTask(String),
    #[error("import failed: {0}")]
    Import(String),
    #[error("media source verification failed: {0}")]
    MediaSource(String),
    #[error("L1 analysis failed: {0}")]
    Analysis(String),
    #[error("motion analysis failed: {0}")]
    Motion(String),
    #[error("artifact generation failed: {0}")]
    Artifact(String),
    #[error("export failed: {0}")]
    Export(String),
    #[error("Jianying draft generation failed: {0}")]
    Jianying(String),
    #[error("LLM enhancement failed: {0}")]
    Llm(String),
    #[error("rating failed: {0}")]
    Rating(String),
    #[error("transcription failed: {0}")]
    Transcription(String),
    #[error("Chinese-CLIP sidecar failed: {0}")]
    Sidecar(String),
    #[error("clip search failed: {0}")]
    ClipSearch(String),
    #[error("clip dimension classification failed: {0}")]
    ClipDimensions(String),
    #[error("similar clip clustering failed: {0}")]
    Similar(String),
    #[error("storyboard failed: {0}")]
    Story(String),
    #[error("shot stack failed: {0}")]
    ShotStack(String),
    #[error("asset safety failed: {0}")]
    AssetSafety(String),
    #[error("channel memory failed: {0}")]
    ChannelMemory(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
