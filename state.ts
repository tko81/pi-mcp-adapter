import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConsentManager } from "./consent-manager.ts";
import type { McpLifecycleManager } from "./lifecycle.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { ToolMetadata, McpConfig, UiSessionMessages, UiStreamSummary } from "./types.ts";
import type { UiResourceHandler } from "./ui-resource-handler.ts";
import type { UiServerHandle } from "./ui-server.ts";

/** 一次 MCP App UI 会话结束后保留的消息与流摘要，供 Proxy 的 ui-messages 操作读取。 */
export interface CompletedUiSession {
  /** 提供 UI Tool 的 MCP Server 名称。 */
  serverName: string;
  /** 本次 UI 会话执行的原始 MCP Tool 名称。 */
  toolName: string;
  /** 会话完成时间，用于排序和展示。 */
  completedAt: Date;
  /** 会话结束原因，例如正常完成、取消或异常。 */
  reason: string;
  /** UI 向 Agent 发送的 prompts、intents 和 notifications。 */
  messages: UiSessionMessages;
  /** 流式 UI 会话的可选统计摘要。 */
  stream?: UiStreamSummary;
}

/** 扩展向 Pi 会话写入自定义消息时使用的最小函数签名。 */
export type SendMessageFn = (
  message: {
    /** 自定义消息类型，供上下文过滤和渲染器识别。 */
    customType: string;
    /** 写入会话的文本内容块。 */
    content: Array<{ type: "text"; text: string }>;
    /** UI 中可选的替代展示文本。 */
    display?: string;
    /** 不直接展示、但可供事件处理器读取的结构化数据。 */
    details?: unknown;
  },
  /** triggerTurn=true 时，消息写入后触发下一轮 Agent。 */
  options?: { triggerTurn?: boolean }
) => void;

/**
 * MCP Adapter 单个 Pi 会话的运行时聚合根。连接、元数据、配置、生命周期和 UI 状态都从这里取得，
 * 避免使用进程级全局变量导致多个 AgentSession 互相污染。
 */
export interface McpExtensionState {
  /** 管理 MCP Client、Transport、连接复用和真实协议调用。 */
  manager: McpServerManager;
  /** 管理 keep-alive 重连、健康检查和空闲连接回收。 */
  lifecycle: McpLifecycleManager;
  /** 按 Server 名称索引的工具发现目录；存在元数据不代表当前已连接。 */
  toolMetadata: Map<string, ToolMetadata[]>;
  /** 合并并规范化后的 MCP 配置。 */
  config: McpConfig;
  /** 最近连接失败时间，用于短期退避，避免每次调用都立即重连。 */
  failureTracker: Map<string, number>;
  /** 读取 MCP App UI Resource 的处理器。 */
  uiResourceHandler: UiResourceHandler;
  /** 控制需要用户同意的 MCP 能力调用。 */
  consentManager: ConsentManager;
  /** 本地 MCP App UI Server；未启动时为 null。 */
  uiServer: UiServerHandle | null;
  /** 已完成的 UI 会话队列，供 Agent 后续取回交互消息。 */
  completedUiSessions: CompletedUiSession[];
  /** 使用当前 Pi 环境打开 OAuth 或 MCP App URL。 */
  openBrowser: (url: string) => Promise<void>;
  /** 非交互模式下不存在的 Pi UI 接口。 */
  ui?: ExtensionContext["ui"];
  /** 向当前会话发送自定义消息的可选入口。 */
  sendMessage?: SendMessageFn;
}
