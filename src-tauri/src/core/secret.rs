//! MiniMax API key storage via the macOS Keychain (`security` CLI).
//!
//! Global constraint (see R7 task brief): the key never appears in argv — it
//! only crosses the process boundary via stdin (write) or stdout (read).
//! `security add-generic-password ... -w` with `-w` as the *last* argument
//! (no value attached) reads the password from stdin instead of prompting on
//! a TTY; `security find-generic-password ... -w` prints the stored password
//! to stdout. Existence checks (`has_minimax_key`) never request `-w` at all,
//! so the key is never even materialized for that call.
//!
//! Item identity: service `tripcut-minimax`, account `tripcut`.
//!
//! Tests must not touch the real Keychain, so every operation is written
//! against the `CommandRunner` trait; production code uses `SystemCommandRunner`
//! (a thin wrapper over `std::process::Command`), tests inject a fake that
//! records what it was called with.

use std::io::Write;
use std::process::{Command, Stdio};

use super::error::{CoreError, Result};

const SERVICE: &str = "tripcut-minimax";
const ACCOUNT: &str = "tripcut";

/// Result of running one subprocess: whether it exited successfully, and its
/// captured stdout/stderr.
#[derive(Debug, Clone, Default)]
pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Abstraction over invoking an external command so `secret.rs` can be tested
/// without ever shelling out to the real `security` binary.
pub trait CommandRunner {
    /// Runs `program` with `args`. When `stdin_input` is `Some`, it is written
    /// to the child's stdin and the pipe is then closed; the key must reach
    /// the child ONLY this way — never via `args`.
    fn run(&self, program: &str, args: &[&str], stdin_input: Option<&str>) -> std::io::Result<CommandOutput>;
}

/// Real `security` invocation used in production.
pub struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(&self, program: &str, args: &[&str], stdin_input: Option<&str>) -> std::io::Result<CommandOutput> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        if let Some(input) = stdin_input {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| std::io::Error::other("security stdin unavailable"))?;
            stdin.write_all(input.as_bytes())?;
        } else {
            // Drop stdin immediately so `security` never blocks waiting for
            // input we never intend to send.
            drop(child.stdin.take());
        }
        let output = child.wait_with_output()?;
        Ok(CommandOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

fn has_minimax_key_with(runner: &dyn CommandRunner) -> Result<bool> {
    let output = runner
        .run(
            "security",
            &["find-generic-password", "-a", ACCOUNT, "-s", SERVICE],
            None,
        )
        .map_err(CoreError::from)?;
    Ok(output.success)
}

fn read_minimax_key_with(runner: &dyn CommandRunner) -> Result<Option<String>> {
    let output = runner
        .run(
            "security",
            &["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"],
            None,
        )
        .map_err(CoreError::from)?;
    if !output.success {
        return Ok(None);
    }
    let key = output.stdout.trim().to_owned();
    if key.is_empty() {
        Ok(None)
    } else {
        Ok(Some(key))
    }
}

fn store_minimax_key_with(runner: &dyn CommandRunner, key: &str) -> Result<()> {
    // `-w` as the last flag (no attached value) makes `security` read the
    // password from stdin — the key never appears in `args`.
    let stdin_payload = format!("{key}\n{key}\n");
    let output = runner
        .run(
            "security",
            &[
                "add-generic-password",
                "-U",
                "-a",
                ACCOUNT,
                "-s",
                SERVICE,
                "-w",
            ],
            // 实测(2026-09-10):`-w` 放末尾时 security 会连读两行——"password data"
            // 与 "retype password"——只喂一行会以 "passwords don't match" 失败。
            Some(&stdin_payload),
        )
        .map_err(CoreError::from)?;
    if output.success {
        Ok(())
    } else {
        Err(CoreError::InvalidSchema(format!(
            "写入 MiniMax API Key 到钥匙串失败：{}",
            output.stderr.trim()
        )))
    }
}

/// Whether a MiniMax key is currently stored. `false` when the Keychain item
/// is absent (never treated as an error).
pub fn has_minimax_key() -> Result<bool> {
    has_minimax_key_with(&SystemCommandRunner)
}

/// Reads the stored MiniMax key, if any.
pub fn read_minimax_key() -> Result<Option<String>> {
    read_minimax_key_with(&SystemCommandRunner)
}

/// Stores (or updates) the MiniMax key.
pub fn store_minimax_key(key: &str) -> Result<()> {
    store_minimax_key_with(&SystemCommandRunner, key)
}

fn clear_minimax_key_with(runner: &dyn CommandRunner) -> Result<()> {
    let output = runner
        .run(
            "security",
            &["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE],
            None,
        )
        .map_err(CoreError::from)?;
    // "清除"是幂等操作:钥匙串里本来就没有这一项也算成功,不能把"未配置"报成错误。
    if output.success || output.stderr.contains("could not be found") {
        Ok(())
    } else {
        Err(CoreError::InvalidSchema(format!(
            "从钥匙串清除 MiniMax API Key 失败：{}",
            output.stderr.trim()
        )))
    }
}

/// Removes the stored MiniMax key, if any. Absence is not an error.
pub fn clear_minimax_key() -> Result<()> {
    clear_minimax_key_with(&SystemCommandRunner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Debug, Clone)]
    struct RecordedCall {
        program: String,
        args: Vec<String>,
        stdin_input: Option<String>,
    }

    /// Fake runner: never touches the real Keychain. Records every call so
    /// tests can assert on argv/stdin shape, and returns a scripted response.
    struct FakeCommandRunner {
        calls: RefCell<Vec<RecordedCall>>,
        response: CommandOutput,
    }

    impl FakeCommandRunner {
        fn new(response: CommandOutput) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                response,
            }
        }
    }

    impl CommandRunner for FakeCommandRunner {
        fn run(&self, program: &str, args: &[&str], stdin_input: Option<&str>) -> std::io::Result<CommandOutput> {
            self.calls.borrow_mut().push(RecordedCall {
                program: program.to_owned(),
                args: args.iter().map(|value| (*value).to_owned()).collect(),
                stdin_input: stdin_input.map(str::to_owned),
            });
            Ok(self.response.clone())
        }
    }

    #[test]
    fn store_and_read_roundtrip_never_puts_key_in_argv() {
        let key = "sk-minimax-secret-should-only-use-stdin";

        let store_runner = FakeCommandRunner::new(CommandOutput {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
        });
        store_minimax_key_with(&store_runner, key).unwrap();

        let store_calls = store_runner.calls.borrow();
        assert_eq!(store_calls.len(), 1);
        let store_call = &store_calls[0];
        assert_eq!(store_call.program, "security");
        assert!(
            !store_call.args.iter().any(|argument| argument == key),
            "key 绝不能出现在 argv 里"
        );
        assert_eq!(store_call.stdin_input.as_deref(), Some(format!("{key}\n{key}\n").as_str()));
        assert_eq!(store_call.args.last().map(String::as_str), Some("-w"));

        let read_runner = FakeCommandRunner::new(CommandOutput {
            success: true,
            stdout: format!("{key}\n"),
            stderr: String::new(),
        });
        let read_back = read_minimax_key_with(&read_runner).unwrap();
        assert_eq!(read_back.as_deref(), Some(key));

        let read_calls = read_runner.calls.borrow();
        assert_eq!(read_calls.len(), 1);
        assert!(
            !read_calls[0].args.iter().any(|argument| argument == key),
            "key 绝不能出现在 argv 里"
        );
        assert!(read_calls[0].stdin_input.is_none());
    }

    #[test]
    fn store_uses_service_and_account_identity() {
        let runner = FakeCommandRunner::new(CommandOutput {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
        });
        store_minimax_key_with(&runner, "irrelevant-value").unwrap();
        let calls = runner.calls.borrow();
        let args = &calls[0].args;
        assert!(args.windows(2).any(|pair| pair == ["-s", SERVICE]));
        assert!(args.windows(2).any(|pair| pair == ["-a", ACCOUNT]));
    }

    #[test]
    fn store_failure_surfaces_as_error() {
        let runner = FakeCommandRunner::new(CommandOutput {
            success: false,
            stdout: String::new(),
            stderr: "SecKeychainAddGenericPassword: denied".to_owned(),
        });
        let error = store_minimax_key_with(&runner, "any-key").unwrap_err();
        assert!(error.to_string().contains("钥匙串"));
    }

    #[test]
    fn has_minimax_key_is_false_when_item_is_absent() {
        let runner = FakeCommandRunner::new(CommandOutput {
            success: false,
            stdout: String::new(),
            stderr: "The specified item could not be found in the keychain.".to_owned(),
        });
        assert!(!has_minimax_key_with(&runner).unwrap());
    }

    #[test]
    fn has_minimax_key_never_requests_the_secret_value() {
        let runner = FakeCommandRunner::new(CommandOutput {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
        });
        assert!(has_minimax_key_with(&runner).unwrap());
        let calls = runner.calls.borrow();
        assert!(
            !calls[0].args.iter().any(|argument| argument == "-w"),
            "存在性检查不应该带 -w，避免不必要地取出密钥"
        );
    }

    #[test]
    fn read_minimax_key_returns_none_when_stdout_is_blank() {
        let runner = FakeCommandRunner::new(CommandOutput {
            success: true,
            stdout: "  \n".to_owned(),
            stderr: String::new(),
        });
        assert_eq!(read_minimax_key_with(&runner).unwrap(), None);
    }

    #[test]
    fn clear_minimax_key_uses_delete_generic_password_with_identity() {
        let runner = FakeCommandRunner::new(CommandOutput {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
        });
        clear_minimax_key_with(&runner).unwrap();
        let calls = runner.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args[0], "delete-generic-password");
        assert!(calls[0].args.windows(2).any(|pair| pair == ["-s", SERVICE]));
        assert!(calls[0].args.windows(2).any(|pair| pair == ["-a", ACCOUNT]));
    }

    #[test]
    fn clear_minimax_key_is_idempotent_when_item_is_already_absent() {
        let runner = FakeCommandRunner::new(CommandOutput {
            success: false,
            stdout: String::new(),
            stderr: "The specified item could not be found in the keychain.".to_owned(),
        });
        clear_minimax_key_with(&runner).unwrap();
    }

    #[test]
    fn clear_minimax_key_surfaces_other_failures() {
        let runner = FakeCommandRunner::new(CommandOutput {
            success: false,
            stdout: String::new(),
            stderr: "SecKeychainItemDelete: permission denied".to_owned(),
        });
        let error = clear_minimax_key_with(&runner).unwrap_err();
        assert!(error.to_string().contains("钥匙串"));
    }
}
