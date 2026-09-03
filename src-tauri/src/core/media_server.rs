use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, ORIGIN,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use uuid::Uuid;

use super::error::Result;

const PRODUCTION_ORIGIN: &str = "tauri://localhost";
const DEVELOPMENT_ORIGIN: &str = "http://127.0.0.1:1420";
const SIGNED_URL_TTL: Duration = Duration::from_secs(5 * 60);
const SIGNED_URL_CLOCK_SKEW: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
pub struct MediaServerInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Clone)]
pub struct MediaServerState {
    cache_root: Arc<PathBuf>,
    token: Arc<str>,
}

#[derive(Default, Deserialize)]
struct CacheAuthQuery {
    expires: Option<u64>,
    signature: Option<String>,
}

impl MediaServerState {
    pub fn new(cache_root: PathBuf, token: String) -> Self {
        Self {
            cache_root: Arc::new(cache_root),
            token: Arc::from(token),
        }
    }
}

pub fn router(state: MediaServerState) -> Router {
    Router::new()
        .route(
            "/cache/{*path}",
            get(serve_cache_file).options(cache_preflight),
        )
        .with_state(state)
}

async fn serve_cache_file(
    State(state): State<MediaServerState>,
    AxumPath(requested_path): AxumPath<String>,
    Query(query): Query<CacheAuthQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(origin) = allowed_origin(&headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !is_authorized(&headers, &query, &requested_path, &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let relative_path = Path::new(&requested_path);
    if !is_cache_artifact_path(relative_path) {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let file_path = state.cache_root.join(relative_path);
    match tokio::fs::read(&file_path).await {
        Ok(bytes) => {
            let content_type = HeaderValue::from_static(content_type_for(&file_path));
            (
                [
                    (CONTENT_TYPE, content_type),
                    (ACCESS_CONTROL_ALLOW_ORIGIN, origin),
                    (CACHE_CONTROL, HeaderValue::from_static("no-store")),
                ],
                Body::from(bytes),
            )
                .into_response()
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(error) => {
            tracing::error!(%error, path = %file_path.display(), "cache file read failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn cache_preflight(headers: HeaderMap) -> Response {
    let Some(origin) = allowed_origin(&headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    (
        StatusCode::NO_CONTENT,
        [
            (ACCESS_CONTROL_ALLOW_ORIGIN, origin),
            (ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET")),
            (
                ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("authorization"),
            ),
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
    )
        .into_response()
}

fn allowed_origin(headers: &HeaderMap) -> Option<HeaderValue> {
    headers.get(ORIGIN).and_then(|origin| {
        origin
            .to_str()
            .is_ok_and(|value| value == PRODUCTION_ORIGIN || value == DEVELOPMENT_ORIGIN)
            .then(|| origin.clone())
    })
}

fn is_authorized(
    headers: &HeaderMap,
    query: &CacheAuthQuery,
    requested_path: &str,
    token: &str,
) -> bool {
    let expected = format!("Bearer {token}");
    let bearer_matches = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected);
    bearer_matches
        || unix_now().is_some_and(|now| signed_query_matches(query, requested_path, token, now))
}

fn signed_query_matches(
    query: &CacheAuthQuery,
    requested_path: &str,
    token: &str,
    now: u64,
) -> bool {
    let (Some(expires), Some(signature)) = (query.expires, query.signature.as_deref()) else {
        return false;
    };
    if expires < now
        || expires.saturating_sub(now)
            > SIGNED_URL_TTL.as_secs() + SIGNED_URL_CLOCK_SKEW.as_secs()
    {
        return false;
    }
    constant_time_eq(
        signature.as_bytes(),
        sign_cache_path(token, requested_path, expires).as_bytes(),
    )
}

fn sign_cache_path(token: &str, requested_path: &str, expires: u64) -> String {
    let key = blake3::hash(token.as_bytes());
    blake3::keyed_hash(
        key.as_bytes(),
        format!("cache\0{requested_path}\0{expires}").as_bytes(),
    )
    .to_hex()
    .to_string()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn unix_now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

pub fn signed_cache_url(
    port: u16,
    token: &str,
    clip_id: i64,
    file_name: &str,
) -> Result<String> {
    let requested_path = format!("{clip_id}/{file_name}");
    if !is_cache_artifact_path(Path::new(&requested_path)) {
        return Err(super::error::CoreError::Artifact(
            "拒绝为无效缓存路径签名".to_owned(),
        ));
    }
    let expires = unix_now()
        .ok_or_else(|| {
            super::error::CoreError::BackgroundTask(
                "系统时间早于 Unix epoch，无法签名缓存 URL".to_owned(),
            )
        })?
        .saturating_add(SIGNED_URL_TTL.as_secs());
    let signature = sign_cache_path(token, &requested_path, expires);
    Ok(format!(
        "http://127.0.0.1:{port}/cache/{requested_path}?expires={expires}&signature={signature}"
    ))
}

fn is_cache_artifact_path(path: &Path) -> bool {
    let mut components = path.components();
    let clip_id_is_valid = matches!(
        components.next(),
        Some(Component::Normal(value))
            if value.to_str().is_some_and(|value| value.parse::<i64>().is_ok_and(|id| id > 0))
    );
    let file_is_valid = matches!(
        components.next(),
        Some(Component::Normal(value))
            if matches!(
                value.to_str(),
                Some("cover.jpg" | "strip.jpg" | "proxy.mp4" | "waveform.json")
            )
    );
    clip_id_is_valid && file_is_valid && components.next().is_none()
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("json") => "application/json",
        Some("mp4") => "video/mp4",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

pub async fn start(cache_root: PathBuf) -> Result<MediaServerInfo> {
    tokio::fs::create_dir_all(&cache_root).await?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let state = MediaServerState::new(cache_root, token.clone());

    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router(state)).await {
            tracing::error!(%error, "loopback cache server stopped");
        }
    });

    Ok(MediaServerInfo { port, token })
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use tower::ServiceExt;

    use super::*;
    use crate::core::test_support::TestDirectory;

    fn request(uri: &str, token: Option<&str>, origin: &str) -> Request<Body> {
        let mut builder = Request::builder().uri(uri).header(ORIGIN, origin);
        if let Some(token) = token {
            builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        builder.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn cache_request_without_token_returns_401() {
        let directory = TestDirectory::new();
        let app = router(MediaServerState::new(
            directory.path().to_path_buf(),
            "secret".into(),
        ));

        let response = app
            .oneshot(request("/cache/42/cover.jpg", None, PRODUCTION_ORIGIN))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn cache_path_traversal_returns_400() {
        let directory = TestDirectory::new();
        let app = router(MediaServerState::new(
            directory.path().to_path_buf(),
            "secret".into(),
        ));

        let response = app
            .oneshot(request(
                "/cache/%2e%2e/private.txt",
                Some("secret"),
                PRODUCTION_ORIGIN,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn authorized_cache_request_returns_200() {
        let directory = TestDirectory::new();
        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(&cache_root).unwrap();
        std::fs::create_dir_all(cache_root.join("42")).unwrap();
        std::fs::write(cache_root.join("42/cover.jpg"), b"image").unwrap();
        let app = router(MediaServerState::new(cache_root, "secret".into()));

        let response = app
            .oneshot(request(
                "/cache/42/cover.jpg",
                Some("secret"),
                PRODUCTION_ORIGIN,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "image/jpeg");
        assert_eq!(response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], PRODUCTION_ORIGIN);
    }

    #[tokio::test]
    async fn browser_cache_url_accepts_a_short_lived_signature() {
        let directory = TestDirectory::new();
        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(cache_root.join("7")).unwrap();
        std::fs::write(cache_root.join("7/waveform.json"), b"{}").unwrap();
        let app = router(MediaServerState::new(cache_root, "secret".into()));

        let signed = signed_cache_url(0, "secret", 7, "waveform.json").unwrap();
        let uri = signed.strip_prefix("http://127.0.0.1:0").unwrap();
        let response = app
            .oneshot(request(uri, None, DEVELOPMENT_ORIGIN))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "application/json");
        assert_eq!(response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], DEVELOPMENT_ORIGIN);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        assert!(!signed.contains("secret"));
        assert!(!signed.contains("token="));
    }

    #[tokio::test]
    async fn raw_query_token_and_wrong_origin_are_rejected() {
        let directory = TestDirectory::new();
        let app = router(MediaServerState::new(
            directory.path().to_path_buf(),
            "secret".into(),
        ));

        let raw_token = app
            .clone()
            .oneshot(request(
                "/cache/7/waveform.json?token=secret",
                None,
                PRODUCTION_ORIGIN,
            ))
            .await
            .unwrap();
        assert_eq!(raw_token.status(), StatusCode::UNAUTHORIZED);

        let wrong_origin = app
            .oneshot(request(
                "/cache/7/waveform.json",
                Some("secret"),
                "https://example.com",
            ))
            .await
            .unwrap();
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn expired_signature_is_rejected() {
        let directory = TestDirectory::new();
        let app = router(MediaServerState::new(
            directory.path().to_path_buf(),
            "secret".into(),
        ));
        let expires = unix_now().unwrap().saturating_sub(1);
        let signature = sign_cache_path("secret", "7/proxy.mp4", expires);
        let uri = format!(
            "/cache/7/proxy.mp4?expires={expires}&signature={signature}"
        );

        let response = app
            .oneshot(request(&uri, None, PRODUCTION_ORIGIN))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn otherwise_valid_signature_cannot_extend_beyond_the_short_ttl() {
        let now = 1_000_u64;
        let expires = now + SIGNED_URL_TTL.as_secs() + SIGNED_URL_CLOCK_SKEW.as_secs() + 1;
        let query = CacheAuthQuery {
            expires: Some(expires),
            signature: Some(sign_cache_path("secret", "7/proxy.mp4", expires)),
        };

        assert!(!signed_query_matches(
            &query,
            "7/proxy.mp4",
            "secret",
            now,
        ));
    }

    #[tokio::test]
    async fn authorization_preflight_echoes_only_the_exact_app_origin() {
        let directory = TestDirectory::new();
        let app = router(MediaServerState::new(
            directory.path().to_path_buf(),
            "secret".into(),
        ));
        let request = Request::builder()
            .method(Method::OPTIONS)
            .uri("/cache/7/proxy.mp4")
            .header(ORIGIN, PRODUCTION_ORIGIN)
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], PRODUCTION_ORIGIN);
        assert_eq!(response.headers()[ACCESS_CONTROL_ALLOW_HEADERS], "authorization");
    }
}
