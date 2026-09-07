// M2 review 修复的专项单测:updaterErrorMessage 的分类判据只认英文原文里的
// "signature"(大小写不敏感)。SettingsPage.test.tsx 已经覆盖了它在设置页文案里的
// 呈现;这里只测分类函数本身——真正的签名错误 vs. 长得像但其实是别的错误。
import { describe, expect, it } from "vitest";

import { updaterErrorMessage } from "./updaterClient";

describe("updaterErrorMessage classifier", () => {
  it("classifies a minisign verification failure as a signature error", () => {
    const message = updaterErrorMessage(new Error("The signature verification failed"));
    expect(message).toBe(
      "更新包签名校验失败，已拒绝安装：The signature verification failed",
    );
  });

  it("classifies the SignatureUtf8 decode-failure wording as a signature error too", () => {
    // tauri-plugin-updater::Error::SignatureUtf8 的文案本身带 "signature"。
    const detail =
      "The signature abc could not be decoded, please check if it is a valid base64 string.";
    expect(updaterErrorMessage(new Error(detail))).toBe(
      `更新包签名校验失败，已拒绝安装：${detail}`,
    );
  });

  it("is case-insensitive on the word 'signature'", () => {
    expect(updaterErrorMessage(new Error("SIGNATURE verification FAILED"))).toContain(
      "校验失败",
    );
  });

  it("does NOT classify a plain decode/base64 error as a signature failure", () => {
    // 这是本轮 review 发现的假阳性来源:旧正则还挂了 /decod|base64|verif/,
    // 一个纯粹的传输层解码错误("error decoding response body")会被误判成签名失败,
    // 让负例断言在错误的原因上通过。
    for (const detail of [
      "error decoding response body",
      "Invalid symbol 46, offset 11",
      "Invalid encoding in minisign data",
      "base64 decode error",
    ]) {
      const message = updaterErrorMessage(new Error(detail));
      expect(message).toBe(`更新失败：${detail}`);
      expect(message).not.toContain("签名");
    }
  });

  it("does not classify an unrelated network error as a signature failure", () => {
    const message = updaterErrorMessage(new Error("error sending request for url"));
    expect(message).toBe("更新失败：error sending request for url");
  });

  it("falls back to a generic 未知错误 detail for an error with no message", () => {
    expect(updaterErrorMessage(new Error(""))).toBe("更新失败：未知错误");
  });

  // R6 终审发现的第二个假阳性来源:reqwest 的传输层错误 Display 会在末尾带上
  // `for url (...)`。GitHub release 资产会 302 到
  // objects.githubusercontent.com/...?X-Amz-Signature=... ,于是一条纯粹的
  // "下载中途断网"错误串里也会含 "Signature",在旧的 /signature/i 判据下会被
  // 误判成「更新包签名校验失败」。
  it("does not classify a transport error whose URL happens to contain a signed query string as a signature failure", () => {
    const detail =
      "error sending request for url (https://objects.githubusercontent.com/release/1?X-Amz-Signature=abc123&X-Amz-Algorithm=AWS4-HMAC-SHA256)";
    const message = updaterErrorMessage(new Error(detail));
    expect(message).toBe(`更新失败：${detail}`);
    expect(message).not.toContain("签名校验失败");
  });

  it("also strips the alternate '(url: ...)' transport-error suffix before classifying", () => {
    const detail =
      "connection closed before message completed (url: https://cdn.example.com/pkg?X-Amz-Signature=zzz)";
    const message = updaterErrorMessage(new Error(detail));
    expect(message).toBe(`更新失败：${detail}`);
    expect(message).not.toContain("签名校验失败");
  });

  it("still classifies a real signature verification error even when it also mentions a url", () => {
    // 负例的反面:别把 "for url (...)" 剥得太狠,真正的签名失败仍要能命中。
    const detail =
      "The signature verification failed for url (https://cdn.example.com/pkg?X-Amz-Signature=zzz)";
    const message = updaterErrorMessage(new Error(detail));
    expect(message).toBe(`更新包签名校验失败，已拒绝安装：${detail}`);
  });
});
