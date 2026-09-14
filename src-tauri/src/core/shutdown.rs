//! X-07(R12 验收):SIGTERM / SIGINT 是正常的退出路径(注销、关机、`kill <pid>`、终端 Ctrl-C),
//! 要走与 ⌘Q 相同的收尾——清掉「会话进行中」哨兵;否则下次启动出现「上次会话没有正常结束」恢复页。
//! SIGKILL / 崩溃仍然留哨兵,那才是真的异常退出。

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use super::error::Result;

/// 算「正常退出」的信号。
pub const GRACEFUL_SIGNALS: [i32; 2] = [libc::SIGTERM, libc::SIGINT];

pub fn is_graceful_signal(signal: i32) -> bool {
    GRACEFUL_SIGNALS.contains(&signal)
}

/// 收到信号时的哨兵收尾:优雅信号 → 取走根目录并清哨兵(幂等:取走之后 `RunEvent::Exit` 再来
/// 也不会重复);其它信号不碰哨兵(仍算异常退出)。返回这次有没有清。
pub fn finish_session_for_signal(root: &Mutex<Option<PathBuf>>, signal: i32) -> Result<bool> {
    if !is_graceful_signal(signal) {
        return Ok(false);
    }
    let Some(root) = root.lock().unwrap_or_else(PoisonError::into_inner).take() else {
        return Ok(false);
    };
    super::doctor::clear_sentinel(&root)?;
    Ok(true)
}

/// 把优雅信号从默认处置(直接终止进程)改成交给一条 `sigwait` 线程。**必须在进程起任何其它
/// 线程之前调用**——信号掩码按线程继承,后起的 tokio / worker 线程才会跟着屏蔽,信号才会
/// 只落到这条线程上。回调在这条线程里跑,由它决定收尾与退出。
pub fn watch(on_signal: impl Fn(i32) + Send + 'static) -> std::io::Result<()> {
    // SAFETY:sigemptyset / sigaddset / pthread_sigmask / sigwait 都是 POSIX 标准调用,
    // `set` 在本函数与线程闭包里各自完整初始化后才使用。
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in GRACEFUL_SIGNALS {
            libc::sigaddset(&mut set, signal);
        }
        if libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    std::thread::Builder::new().name("graceful-signals".to_owned()).spawn(move || loop {
        let mut signal: libc::c_int = 0;
        // SAFETY:同上;`set` 在此线程内重新构造。
        let status = unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            for graceful in GRACEFUL_SIGNALS {
                libc::sigaddset(&mut set, graceful);
            }
            libc::sigwait(&set, &mut signal)
        };
        if status != 0 {
            tracing::warn!(status, "sigwait 失败,优雅信号线程退出");
            return;
        }
        on_signal(signal);
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{doctor, test_support::TestDirectory};

    #[test]
    fn sigterm_clears_the_session_marker_like_a_clean_quit_and_is_idempotent() {
        let directory = TestDirectory::new();
        assert!(!doctor::begin_session(directory.path()).unwrap(), "全新目录没有哨兵");
        let root = Mutex::new(Some(directory.path().to_path_buf()));

        assert!(finish_session_for_signal(&root, libc::SIGTERM).unwrap());
        assert!(!doctor::begin_session(directory.path()).unwrap(), "SIGTERM 之后再启动不算异常退出");
        // 根目录已被取走:Exit 事件再来也不会二次清(与 lib.rs 里 `take()` 的约定一致)。
        assert!(root.lock().unwrap().is_none());
        assert!(!finish_session_for_signal(&root, libc::SIGTERM).unwrap());
    }

    #[test]
    fn non_graceful_signals_leave_the_marker_in_place() {
        let directory = TestDirectory::new();
        doctor::begin_session(directory.path()).unwrap();
        let root = Mutex::new(Some(directory.path().to_path_buf()));
        assert!(!finish_session_for_signal(&root, libc::SIGUSR1).unwrap());
        assert!(root.lock().unwrap().is_some(), "根目录还在,正常退出仍能清");
        assert!(doctor::begin_session(directory.path()).unwrap(), "哨兵还在:下次启动算异常退出");
        assert!(is_graceful_signal(libc::SIGINT) && !is_graceful_signal(libc::SIGKILL));
    }
}
