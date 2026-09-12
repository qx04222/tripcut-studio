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
    #[error("player preference failed: {0}")]
    Player(String),
    #[error("contact sheet generation failed: {0}")]
    ContactSheet(String),
    #[error("OCR failed: {0}")]
    Ocr(String),
    #[error("music analysis failed: {0}")]
    Music(String),
    #[error("story gap detection failed: {0}")]
    StoryGap(String),
    #[error("cloud generation failed: {0}")]
    Generation(String),
    /// R7 Task 5 幂等闸:同一个缺口在 `submitted`/`queued`/`succeeded` 期间
    /// 只允许有一条生成请求。第二次提交(重复点击、双客户端、重放)必须在
    /// 写请求行与账本行之前就被这条**有类型**的错误挡住——错误消息本身
    /// 是给业主看的那句话,调用方可以 `matches!` 它而不用比字符串。
    #[error("该缺口已有生成请求进行中")]
    GenerationInFlight,
    /// 重新生成只能针对已经走完的失败/取消请求;`submitted`/`queued`/
    /// `succeeded`/`imported` 都不允许——前三者会重复计费,`imported` 已经
    /// 有结果片了。
    #[error("生成请求 {0} 不是失败或已取消状态，无法重新生成")]
    GenerationNotRetryable(i64),
}

pub type Result<T> = std::result::Result<T, CoreError>;
