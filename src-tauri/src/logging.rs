//! R18 车道 settings M-03:让日志真的落盘。
//!
//! 在这之前仓里 123 个 `tracing::` 调用点全部空转 —— 没有任何 subscriber 被装上,
//! 线上出问题只能靠猜。这里装一个:按天滚动写
//! `<素材库根>/logs/tripcut.log.YYYY-MM-DD`,保留 7 天,默认 INFO,
//! `TRIPCUT_LOG=debug` 可以提级。
//!
//! **写进文件之前一律脱敏**。脱敏不是"顺手做一下"——按业主的纪律,
//! [`redact`] 返回替换次数,测试必须断言 **计数 > 0**;一条裸正则对不上时
//! 原样输出的密码/路径,布尔断言是看不出来的(见记忆:脱敏必须断言匹配发生过)。

use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;

/// 家目录路径的前缀:`/Users/<某人>/剩下的` → `~/剩下的`。用户名本身必须消失。
const HOME_PREFIX: &str = "/Users/";
/// 外接盘:`/Volumes/<盘名>/剩下的` → `<卷>/剩下的`。盘名常带人名/项目名,也要消失。
const VOLUME_PREFIX: &str = "/Volumes/";
/// 其余绝对路径整段换掉 —— 它们的层级本身就能泄露机器结构。
const OPAQUE_PREFIXES: &[&str] = &[
    "/private/", "/var/", "/tmp/", "/opt/", "/Applications/", "/Library/", "/home/", "/etc/",
];

/// 路径在哪里结束。跟前端 `workspace/diagnostics.ts` 的 `PATH_PATTERN` 同一套分隔符,
/// 两边对同一条日志给出同样的结果。
fn is_boundary(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '"' | '\'' | '(' | ')' | '、' | ',' | ';' | ':' | '，' | '；')
}

/// 从 `rest`(某个前缀之后的部分)里吃掉一个路径片段,返回 (片段, 之后的下标)。
fn take_segment(rest: &str) -> (&str, usize) {
    let end = rest.find(|ch: char| ch == '/' || is_boundary(ch)).unwrap_or(rest.len());
    (&rest[..end], end)
}

fn take_path(rest: &str) -> usize {
    rest.find(is_boundary).unwrap_or(rest.len())
}

/// 脱敏一段文本。返回 **(脱敏后的文本, 替换了几处)**。
///
/// 计数是这个函数存在的理由之一:调用方(以及测试)必须能区分"没有路径可脱敏"
/// 和"有路径但一条都没匹配上"。后者是缺陷,而只返回字符串是看不出来的。
pub fn redact(text: &str) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut count = 0_usize;
    let mut index = 0_usize;
    while index < text.len() {
        let rest = &text[index..];
        if let Some(after) = rest.strip_prefix(HOME_PREFIX) {
            let (_user, consumed) = take_segment(after);
            out.push('~');
            index += HOME_PREFIX.len() + consumed;
            count += 1;
            continue;
        }
        if let Some(after) = rest.strip_prefix(VOLUME_PREFIX) {
            let (_volume, consumed) = take_segment(after);
            out.push_str("<卷>");
            index += VOLUME_PREFIX.len() + consumed;
            count += 1;
            continue;
        }
        if let Some(prefix) = OPAQUE_PREFIXES.iter().find(|prefix| rest.starts_with(**prefix)) {
            let consumed = take_path(&rest[prefix.len()..]);
            out.push_str("<路径>");
            index += prefix.len() + consumed;
            count += 1;
            continue;
        }
        let ch = rest.chars().next().expect("rest 非空");
        out.push(ch);
        index += ch.len_utf8();
    }
    (out, count)
}

/// 包一层 `Write`:每一批写进来的字节先脱敏再落盘。
/// 放在 writer 这一层(而不是某个 `Layer`)是因为这里看到的已经是格式化完的整行,
/// 字段值、message、span 名一次全覆盖 —— 不会漏掉某个没走 `%` 的字段。
struct RedactingWriter<W: Write>(W);

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        let (redacted, _count) = redact(&text);
        self.0.write_all(redacted.as_bytes())?;
        // 对上层始终报"全写完了":脱敏后的长度和原始长度不一样,
        // 报脱敏后的长度会让调用方以为没写完然后重发一遍。
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

#[derive(Clone)]
struct RedactingMakeWriter(tracing_appender::non_blocking::NonBlocking);

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RedactingMakeWriter {
    type Writer = RedactingWriter<tracing_appender::non_blocking::NonBlocking>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter(self.0.clone())
    }
}

/// `TRIPCUT_LOG` → 级别。默认 INFO;认不出来的值也按 INFO 走(不因为一个拼错的
/// 环境变量把日志整条关掉)。
fn level_from_env() -> tracing::level_filters::LevelFilter {
    use tracing::level_filters::LevelFilter;
    match std::env::var("TRIPCUT_LOG").unwrap_or_default().to_ascii_lowercase().as_str() {
        "trace" => LevelFilter::TRACE,
        "debug" => LevelFilter::DEBUG,
        "warn" => LevelFilter::WARN,
        "error" => LevelFilter::ERROR,
        "off" => LevelFilter::OFF,
        _ => LevelFilter::INFO,
    }
}

/// 日志文件的基名;轮转后是 `tripcut.log.2026-09-14`。
pub const LOG_FILE_PREFIX: &str = "tripcut.log";
/// 保留几天。跟 `doctor::prune_panic_logs` 的保留窗口一致。
pub const LOG_RETENTION_DAYS: usize = 7;

static GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

/// 装上 subscriber。**只能装一次**(全局的),重复调用会被 `set_global_default` 拒绝,
/// 这里把它当成"已经装好了"静默返回,不 panic —— 日志装不上不该拖垮启动。
pub fn init(logs_dir: &Path) {
    if GUARD.get().is_some() {
        return;
    }
    if std::fs::create_dir_all(logs_dir).is_err() {
        return;
    }
    let Ok(appender) = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .max_log_files(LOG_RETENTION_DAYS)
        .build(logs_dir)
    else {
        return;
    };
    let (non_blocking, guard) = tracing_appender::non_blocking(appender);
    let subscriber = tracing_subscriber::fmt()
        .with_writer(RedactingMakeWriter(non_blocking))
        .with_ansi(false)
        .with_max_level(level_from_env())
        .finish();
    if tracing::subscriber::set_global_default(subscriber).is_err() {
        return;
    }
    let _ = GUARD.set(guard);
    tracing::info!(retention_days = LOG_RETENTION_DAYS, "日志已开始落盘(路径已脱敏)");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// M-03:家目录里的用户名必须消失,而且**替换必须真的发生过**。
    /// 只断言 `!contains("xin")` 是假绿的:正则/前缀写错时整串原样输出,
    /// 而"xin"恰好不在里面的样本一样能过。所以这里钉计数。
    #[test]
    fn redact_replaces_home_paths_and_counts_the_replacements() {
        let (text, count) = redact("打开 /Users/xin/Movies/旅行/a.mov 失败");
        assert!(count > 0, "一次替换都没发生 —— 这条脱敏是空的");
        assert_eq!(count, 1);
        assert!(!text.contains("xin"), "用户名还在:{text}");
        assert_eq!(text, "打开 ~/Movies/旅行/a.mov 失败");
    }

    /// 卷名(常带人名/项目名)也要消失;一行里有几条就数几条。
    #[test]
    fn redact_handles_volumes_and_opaque_prefixes_with_a_matching_count() {
        let (text, count) = redact("从 /Volumes/西数移动盘/DCIM/x.mp4 复制到 /private/var/folders/t/y");
        assert_eq!(count, 2, "两条路径就该有两次替换:{text}");
        assert!(!text.contains("西数移动盘") && !text.contains("folders"), "{text}");
        assert!(text.contains("<卷>/DCIM/x.mp4") && text.contains("<路径>"), "{text}");
    }

    /// 没有路径的行不该被改动,计数为 0 —— 计数不是"越大越好",它是个判据。
    #[test]
    fn redact_leaves_path_free_lines_alone() {
        let (text, count) = redact("memory profile resolved profile=standard worker_count=4");
        assert_eq!(count, 0);
        assert_eq!(text, "memory profile resolved profile=standard worker_count=4");
    }

    /// 写进文件的那一层也要脱敏(不是只有 `redact` 自己干净)。
    #[test]
    fn the_file_writer_redacts_before_it_writes() {
        let mut sink: Vec<u8> = Vec::new();
        {
            let mut writer = RedactingWriter(&mut sink);
            let line = b"ERROR probe /Users/xin/Movies/a.mov\n";
            assert_eq!(writer.write(line).unwrap(), line.len(), "要对上层报原始长度");
        }
        let written = String::from_utf8(sink).unwrap();
        assert!(!written.contains("/Users/"), "落盘的这一行还带绝对路径:{written}");
        assert!(written.contains("~/Movies/a.mov"), "{written}");
    }
}
