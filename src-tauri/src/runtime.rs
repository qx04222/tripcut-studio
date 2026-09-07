//! R6 Task 4:睡眠/唤醒后的续跑入口。
//!
//! macOS 睡眠期间任何后台任务的租约心跳(`LeaseHeartbeat`,每几秒 UPDATE 一次
//! `lease_expires_at`)都会停摆;睡够久,`recover_expired` 本来就会在下一次
//! worker 认领循环里把它们从「过期的 running」收回成「pending」重跑——但那
//! 依赖 250ms 一次的空闲轮询碰巧撞上。真正的「醒了就立刻处理」入口是这里:
//! `on_wake` 被 `lib.rs` 里订阅的 `NSWorkspaceDidWakeNotification` 调用,
//! 也被 `simulate_wake` 测试命令调用——两条路径共用同一个函数,行为不会分叉。
use tauri::Manager;

use crate::RuntimeState;

/// 唤醒后:清一遍过期租约,叫醒可能还在 idle 轮询里睡觉的 worker。
/// 只读窗口没有起 worker(`RuntimeState::worker_control` 是 `None`),直接跳过。
pub fn on_wake(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<RuntimeState>() else {
        // setup 尚未跑完("Fail" 级 doctor 报告会提前 return Ok(())、不 manage
        // RuntimeState),这时候连素材库都没打开,没有任务好恢复。
        return;
    };
    let Some(control) = state.worker_control.clone() else {
        return;
    };
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn(async move {
        let recovered = tauri::async_runtime::spawn_blocking(move || {
            let mut connection = crate::core::db::open_project(&db_path)?;
            crate::core::jobs::recover_expired(&mut connection)
        })
        .await;
        match recovered {
            Ok(Ok(count)) if count > 0 => {
                tracing::info!(count, "睡眠唤醒后恢复了过期任务租约");
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => tracing::warn!(%error, "睡眠唤醒后恢复任务租约失败"),
            Err(error) => tracing::warn!(%error, "睡眠唤醒恢复任务的后台线程异常退出"),
        }
        control.wake_worker();
    });
}

#[cfg(test)]
mod tests {
    use crate::core::db;
    use crate::core::jobs;
    use crate::core::test_support::TestDirectory;

    /// `on_wake` 复用的核心其实就是 `recover_expired`——这条测试锁定它的
    /// 契约:一条已过期的 `running` 任务在调用后变回 `pending`,可以被重新
    /// 认领。`on_wake` 本身需要一个真实运行的 Tauri App 才能拿到
    /// `AppHandle`/`RuntimeState`,单元测试里没有,所以在这里直接测试它包
    /// 的这一步;`simulate_wake` 命令走的是同一个 `on_wake` 函数,不会分叉
    /// 出第二套恢复逻辑。
    #[test]
    fn recover_expired_moves_an_expired_running_job_back_to_pending() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let job_id = jobs::enqueue(&mut connection, "noop", "{}", "wake-recover").unwrap();
        connection
            .execute(
                "UPDATE jobs SET status='running', owner_id='stale-owner',
                     lease_expires_at='2000-01-01T00:00:00.000Z'
                 WHERE id=?1",
                [job_id],
            )
            .unwrap();

        let recovered = jobs::recover_expired(&mut connection).unwrap();

        assert_eq!(recovered, 1);
        let job = jobs::get(&connection, job_id).unwrap();
        assert_eq!(job.status, jobs::JobStatus::Pending);
    }
}
