// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ openExternalUrl: vi.fn(async () => undefined) }));
vi.mock("../api", () => apiMocks);

import { PRIVACY_FILES_URL, PrivacyAccessHint, isPermissionDenied } from "./PrivacyAccessHint";

describe("PrivacyAccessHint", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("只认权限类错误——别的错误不挂按钮", () => {
    expect(isPermissionDenied("找到它没成功:没有写入权限。")).toBe(true);
    expect(isPermissionDenied("找到它没成功:系统不允许这个操作。")).toBe(true);
    expect(isPermissionDenied("找到它没成功:文件或文件夹不存在。")).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
  });

  it("权限被拒时给一个「去系统设置打开」的按钮,点了直接跳隐私与安全性", () => {
    render(<PrivacyAccessHint text="找到它没成功:系统不允许这个操作。" />);
    fireEvent.click(screen.getByRole("button", { name: "去系统设置打开" }));
    expect(apiMocks.openExternalUrl).toHaveBeenCalledWith(PRIVACY_FILES_URL);
    expect(PRIVACY_FILES_URL).toContain("Privacy_FilesAndFolders");
  });

  it("不是权限问题就什么都不渲染", () => {
    render(<PrivacyAccessHint text="找到它没成功:文件或文件夹不存在。" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
