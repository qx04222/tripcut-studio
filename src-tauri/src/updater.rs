//! 应用内自动更新的运行期配置。
//!
//! 为什么覆盖的是「配置」而不是 `UpdaterBuilder::endpoints()`:
//! 前端点「检查更新」走的是 `@tauri-apps/plugin-updater` 的 `check()`,它调用插件自带的
//! `plugin:updater|check` 命令。那个命令用的是插件注册时(`Builder::build()` 的 setup 里)
//! 从 `plugins.updater` clone 进 `UpdaterState` 的那份配置,和我们在 Rust 侧另外 build 出来的
//! `Updater` 是两个实例——在 `setup()` 里调 `app.updater_builder().endpoints(..)` 只会影响
//! 我们自己那一份,前端那条路径完全看不到。而且 `tauri_plugin_updater::Builder` 只暴露了
//! target/pubkey/headers,没有 endpoints。所以唯一能同时管住两条路径的接缝,是在
//! `tauri::generate_context!()` 之后、`Builder::build(context)` 之前改配置本身。

use std::net::{Ipv4Addr, Ipv6Addr};

use serde_json::{json, Value};
use url::{Host, Url};

/// 读环境变量 `TRIPCUT_UPDATER_ENDPOINT`;为空或未设时返回 `None`。
pub fn endpoint_override_from_env() -> Option<String> {
    let raw = std::env::var("TRIPCUT_UPDATER_ENDPOINT").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 一个端点归到哪一类:决定了是否放行、放行后要不要开传输安全豁免。
enum EndpointClass {
    Https,
    LoopbackHttp,
}

/// `host` 是不是回环:精确等于 127.0.0.1 / ::1 / "localhost",不是前缀匹配。
///
/// 曾经的实现是字符串切片(`rest.rsplit_once(':')` 取主机名),这对
/// `http://127.0.0.1:8080@evil.com/latest.json` 会得出主机是 `127.0.0.1`——
/// 那段其实是 userinfo(`用户名:密码@`),真正的主机是 `evil.com`。改用
/// `url::Url` 解析后按结构取 `host()`,userinfo 和 host 天然是两个字段,
/// 不会再被误认。
fn is_loopback_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => *domain == "localhost",
        Host::Ipv4(ip) => *ip == Ipv4Addr::LOCALHOST,
        Host::Ipv6(ip) => *ip == Ipv6Addr::LOCALHOST,
    }
}

/// 插件在 release 构建里会拒绝任何非 https 端点(config.rs 的 validate_endpoints,
/// 报 `InsecureTransportProtocol`,而且是在插件初始化时炸,表现为应用启动即崩)。
/// 唯一的放行开关是配置里的 `dangerousInsecureTransportProtocol`。这个开关绝不能写进
/// tauri.conf.json——那等于给所有用户永久关掉更新的传输安全;它只在这里、只对
/// 127.0.0.1 / ::1 / localhost 的 http 端点、只在有人显式设了环境变量时临时打开。
/// 别的主机走 http 一律不放行:否则这个环境变量就成了"把任意明文服务器变成更新源"
/// 的现成后门。
///
/// 同时拒绝带 userinfo(`user:pass@host`)的端点——不管走 https 还是 http。合法用途
/// 想不出理由要在更新端点里塞用户名密码,而 `user:pass@` 恰恰是伪装主机最常见的载体
/// (`http://127.0.0.1:8080@evil.com/...` 里 `127.0.0.1:8080` 就是 userinfo,不是主机)。
fn classify_endpoint(endpoint: &str) -> Option<EndpointClass> {
    let url = Url::parse(endpoint).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    match url.scheme() {
        "https" => Some(EndpointClass::Https),
        "http" => {
            let host = url.host()?;
            is_loopback_host(&host).then_some(EndpointClass::LoopbackHttp)
        }
        _ => None,
    }
}

/// 覆盖是否被允许:https 永远可以,http 只在回环上可以。
pub fn endpoint_override_is_allowed(endpoint: &str) -> bool {
    classify_endpoint(endpoint).is_some()
}

/// 把 `plugins.updater.endpoints` 整个换成 `[endpoint]`。
///
/// 换而不是追加:QA 要的是「只准打这一个本地端点」。追加会让生产端点仍然可达,
/// 一旦本地端点先返回 404,插件会顺着列表继续问 GitHub,拿到的是真实发行版——
/// 那时正例看着是绿的,证明的却是另一回事。
///
/// 返回是否真的改到了(`plugins.updater` 不是对象、或端点不被允许时不改,返回 `false`)。
pub fn apply_endpoint_override(updater_plugin_config: &mut Value, endpoint: &str) -> bool {
    if !endpoint_override_is_allowed(endpoint) {
        return false;
    }
    let Some(class) = classify_endpoint(endpoint) else {
        return false;
    };
    let Some(object) = updater_plugin_config.as_object_mut() else {
        return false;
    };
    object.insert("endpoints".to_string(), json!([endpoint]));
    if matches!(class, EndpointClass::LoopbackHttp) {
        object.insert(
            "dangerousInsecureTransportProtocol".to_string(),
            json!(true),
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_endpoint_list_and_keeps_the_public_key() {
        let mut config = json!({
            "pubkey": "PUBKEY",
            "endpoints": ["https://github.com/example/releases/latest/download/latest.json"],
        });

        assert!(apply_endpoint_override(
            &mut config,
            "http://127.0.0.1:8765/latest.json"
        ));

        assert_eq!(config["pubkey"], json!("PUBKEY"));
        assert_eq!(
            config["endpoints"],
            json!(["http://127.0.0.1:8765/latest.json"]),
            "生产端点必须被换掉而不是追加,否则本地端点 404 时会静默回落到真实发行版"
        );
    }

    #[test]
    fn inserts_the_endpoint_list_when_absent() {
        let mut config = json!({ "pubkey": "PUBKEY" });
        assert!(apply_endpoint_override(&mut config, "http://127.0.0.1:1/latest.json"));
        assert_eq!(config["endpoints"], json!(["http://127.0.0.1:1/latest.json"]));
    }

    #[test]
    fn opens_the_insecure_transport_gate_only_for_loopback_http() {
        // 回环 http:必须开(否则 release 构建的插件在初始化时就报
        // InsecureTransportProtocol,应用启动即崩——实测,这条断言是撞出来的)。
        let mut local = json!({ "pubkey": "PUBKEY" });
        assert!(apply_endpoint_override(&mut local, "http://127.0.0.1:8765/latest.json"));
        assert_eq!(local["dangerousInsecureTransportProtocol"], json!(true));

        // https:不开。放宽传输安全没有理由跟着覆盖端点一起发生。
        let mut remote = json!({ "pubkey": "PUBKEY" });
        assert!(apply_endpoint_override(&mut remote, "https://example.com/latest.json"));
        assert_eq!(remote.get("dangerousInsecureTransportProtocol"), None);
    }

    #[test]
    fn refuses_plain_http_to_anything_but_loopback() {
        for endpoint in [
            "http://example.com/latest.json",
            "http://127.0.0.1.evil.com/latest.json",
            "http://10.0.0.1:8765/latest.json",
            "ftp://127.0.0.1/latest.json",
        ] {
            let mut config = json!({ "pubkey": "PUBKEY", "endpoints": ["https://real/latest.json"] });
            assert!(
                !apply_endpoint_override(&mut config, endpoint),
                "{endpoint} 不该被接受"
            );
            assert_eq!(config["endpoints"], json!(["https://real/latest.json"]));
        }
    }

    #[test]
    fn accepts_loopback_hosts_by_name_and_ipv6() {
        for endpoint in [
            "http://localhost:8765/latest.json",
            "http://[::1]:8765/latest.json",
            "http://127.0.0.1/latest.json",
        ] {
            assert!(endpoint_override_is_allowed(endpoint), "{endpoint} 应被接受");
        }
    }

    #[test]
    fn refuses_a_non_object_plugin_config() {
        let mut config = json!("not-an-object");
        assert!(!apply_endpoint_override(&mut config, "http://127.0.0.1:1/latest.json"));
        assert_eq!(config, json!("not-an-object"));
    }

    // M1 (review finding): 字符串切片版会把 userinfo 误认成主机
    // (`127.0.0.1:8080` 在 `user:pass@host` 里是 userinfo,不是 host,真正的
    // host 是 `evil.com`)。改用 url::Url 解析后这类端点必须被拒绝。
    #[test]
    fn refuses_userinfo_disguised_as_loopback_host() {
        assert!(!endpoint_override_is_allowed(
            "http://127.0.0.1:8080@evil.com/x"
        ));
    }

    #[test]
    fn refuses_domain_with_loopback_as_a_label_prefix() {
        assert!(!endpoint_override_is_allowed("http://127.0.0.1.evil.com/x"));
    }

    // L1: 裸 IPv6 回环(无端口)此前被字符串切片的 rsplit_once(':') 拆成
    // host="0.0.0.0.0.0.0.1]"、port="[:" 之类的垃圾,永远拒绝。
    #[test]
    fn accepts_bare_ipv6_loopback_without_port() {
        assert!(endpoint_override_is_allowed("http://[::1]/latest.json"));
    }

    #[test]
    fn accepts_ipv6_loopback_with_port() {
        assert!(endpoint_override_is_allowed("http://[::1]:8765/x"));
    }

    #[test]
    fn refuses_userinfo_on_https_too() {
        assert!(!endpoint_override_is_allowed("https://user:pw@example.com/x"));
    }

    #[test]
    fn accepts_plain_https_without_the_insecure_flag() {
        let mut config = json!({ "pubkey": "PUBKEY" });
        assert!(apply_endpoint_override(&mut config, "https://example.com/x"));
        assert_eq!(config["endpoints"], json!(["https://example.com/x"]));
        assert_eq!(config.get("dangerousInsecureTransportProtocol"), None);
    }

    // Url 把 scheme 统一转小写,所以大写 HTTP 按 http 处理——回环上一样放行。
    #[test]
    fn accepts_uppercase_http_scheme_on_loopback() {
        assert!(endpoint_override_is_allowed("HTTP://127.0.0.1/x"));
    }
}
