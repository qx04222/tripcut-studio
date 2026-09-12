import { useEffect, useState, type JSX, type ReactNode } from "react";

import { Icon } from "./icons";

export interface CoverImageProps {
  /** 封面 URL;null / 空串直接走占位。 */
  src: string | null | undefined;
  /** 没有封面或封面加载失败时显示什么;默认是中性的胶片图标(不是浏览器的坏图问号)。 */
  fallback?: ReactNode;
  lazy?: boolean;
  crossOrigin?: "anonymous";
  className?: string;
}

/**
 * 封面缩略图(R9 D4):`cover_url` 为空或 `<img>` 加载失败(分析失败的素材封面
 * 文件不存在)时,渲染 `--well-bg` 上的中性占位,绝不让浏览器画出坏图「?」。
 * 容器由调用方提供(各处井的尺寸不同),这里只负责「图还是占位」。
 */
export function CoverImage({ src, fallback, lazy = false, crossOrigin, className }: CoverImageProps): JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // 换了一条素材就重新给它一次机会——失败记忆只跟着那一条 URL。
  useEffect(() => setFailedSrc(null), [src]);
  const usable = typeof src === "string" && src.length > 0 && failedSrc !== src;
  if (!usable) {
    return (
      <span className={["ui-cover-missing", className ?? ""].filter(Boolean).join(" ")} aria-hidden="true">
        {fallback ?? <Icon name="film" size={16} />}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className={className}
      crossOrigin={crossOrigin}
      loading={lazy ? "lazy" : undefined}
      decoding={lazy ? "async" : undefined}
      draggable={false}
      onError={() => setFailedSrc(src)}
    />
  );
}
