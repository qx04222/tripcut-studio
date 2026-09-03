import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("界面渲染错误", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="render-error-page" role="alert">
          <h1>界面遇到了一个错误</h1>
          <p>你的素材与项目数据不受影响。可以直接返回工作台继续，问题详情已写入日志。</p>
          <pre>{String(this.state.error?.message ?? this.state.error)}</pre>
          <button type="button" onClick={() => this.setState({ error: null })}>
            返回工作台
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
