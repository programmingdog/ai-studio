import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import "./styles.css";
import { CreditConfirmationHost } from "./components/CreditConfirmationHost";
import { LowCreditReminderHost } from "./components/LowCreditReminderHost";

const queryClient = new QueryClient();

class AppErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("AI Video Studio rendering failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error-screen">
        <section>
          <span>APPLICATION RECOVERY</span>
          <h1>界面加载失败</h1>
          <p>应用读取本地数据后遇到异常。项目数据仍保存在本机，没有被删除或覆盖。</p>
          <pre>{this.state.error.message || String(this.state.error)}</pre>
          <button type="button" onClick={() => window.location.reload()}>重新加载应用</button>
        </section>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider><AppErrorBoundary><CreditConfirmationHost /><App /><LowCreditReminderHost /></AppErrorBoundary></I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
