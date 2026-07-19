import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { existsSync } from "node:fs";
import { loadMcpConfig } from "./config.ts";
import { ConsentManager } from "./consent-manager.ts";
import { McpLifecycleManager } from "./lifecycle.ts";
import {
  computeServerHash,
  getMetadataCachePath,
  isServerCacheValid,
  loadMetadataCache,
  reconstructToolMetadata,
  saveMetadataCache,
  serializeResources,
  serializeTools,
  type ServerCacheEntry,
} from "./metadata-cache.ts";
import { McpServerManager } from "./server-manager.ts";
import { buildToolMetadata, totalToolCount } from "./tool-metadata.ts";
import { UiResourceHandler } from "./ui-resource-handler.ts";
import { openUrl, parallelLimit } from "./utils.ts";
import { logger } from "./logger.ts";
import { getMissingConfiguredDirectToolServers } from "./direct-tools.ts";
import { throwIfAborted } from "./abort.ts";

const FAILURE_BACKOFF_MS = 60 * 1000;

/** 只有带 UI 的 TUI 模式才能安全承接本地浏览器 URL elicitation。 */
export function isTuiMode(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

/**
 * 构造单个会话的 McpExtensionState，并完成缓存恢复、生命周期注册和必要的启动连接。
 * lazy Server 在缓存有效时不会连接；首次没有缓存时会 bootstrap 全部 Server，建立后续发现索引。
 */
export async function initializeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<McpExtensionState> {
  const configPath = pi.getFlag("mcp-config") as string | undefined;
  const config = loadMcpConfig(configPath, ctx.cwd);

  // 第一阶段：创建连接层，并把请求超时、sampling、elicitation 等运行能力注入 manager。
  const manager = new McpServerManager(ctx.cwd);
  manager.setDefaultRequestTimeoutMs(config.settings?.requestTimeoutMs);
  const samplingAutoApprove = config.settings?.samplingAutoApprove === true;
  if (config.settings?.sampling !== false && (ctx.hasUI || samplingAutoApprove)) {
    manager.setSamplingConfig({
      autoApprove: samplingAutoApprove,
      ui: ctx.hasUI ? ctx.ui : undefined,
      modelRegistry: ctx.modelRegistry,
      getCurrentModel: () => ctx.model,
      getSignal: () => ctx.signal,
    });
  }
  const elicitationEnabled = config.settings?.elicitation !== false && ctx.hasUI;
  if (elicitationEnabled) {
    manager.setElicitationConfig({
      ui: ctx.ui,
      allowUrl: isTuiMode(ctx),
    });
  }
  // 第二阶段：组装会话运行时。toolMetadata 是发现索引，failureTracker 是惰性连接退避表。
  const lifecycle = new McpLifecycleManager(manager);
  const toolMetadata = new Map<string, ToolMetadata[]>();
  const failureTracker = new Map<string, number>();
  const uiResourceHandler = new UiResourceHandler(manager);
  const consentManager = new ConsentManager("once-per-server");
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const state: McpExtensionState = {
    manager,
    lifecycle,
    toolMetadata,
    config,
    failureTracker,
    uiResourceHandler,
    consentManager,
    uiServer: null,
    completedUiSessions: [],
    openBrowser: (url: string) => openUrl(pi, url, process.env.BROWSER),
    ui,
    sendMessage: (message, options) => pi.sendMessage(message as unknown as Parameters<typeof pi.sendMessage>[0], options),
  };

  // 没有配置 Server 时仍返回完整 state，使 Proxy 可以稳定报告空状态。
  const serverEntries = Object.entries(config.mcpServers);
  if (serverEntries.length === 0) {
    return state;
  }

  const idleSetting = typeof config.settings?.idleTimeout === "number" ? config.settings.idleTimeout : 10;
  lifecycle.setGlobalIdleTimeout(idleSetting);

  // 第三阶段：恢复持久化元数据。缓存文件首次不存在时，需要连接全部 Server 建立初始快照。
  const cachePath = getMetadataCachePath();
  const cacheFileExists = existsSync(cachePath);
  let cache = loadMetadataCache();
  let bootstrapAll = false;

  if (!cacheFileExists) {
    bootstrapAll = true;
    saveMetadataCache({ version: 1, servers: {} });
  } else if (!cache) {
    cache = { version: 1, servers: {} };
    saveMetadataCache(cache);
  }

  const prefix = config.settings?.toolPrefix ?? "server";

  // 每个 Server 都注册到生命周期管理器；有效缓存则直接重建 ToolMetadata，不启动连接。
  for (const [name, definition] of serverEntries) {
    const lifecycleMode = definition.lifecycle ?? "lazy";
    const idleOverride = definition.idleTimeout ?? (lifecycleMode === "eager" ? 0 : undefined);
    lifecycle.registerServer(
      name,
      definition,
      idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined
    );
    if (lifecycleMode === "keep-alive") {
      lifecycle.markKeepAlive(name, definition);
    }

    if (cache?.servers?.[name] && isServerCacheValid(cache.servers[name], definition)) {
      const metadata = reconstructToolMetadata(name, cache.servers[name], prefix, definition);
      toolMetadata.set(name, metadata);
    }
  }

  // 已有缓存后，启动阶段只连接 eager/keep-alive；lazy 留到 connect/call 时按需建立。
  const startupServers = bootstrapAll
    ? serverEntries
    : serverEntries.filter(([, definition]) => {
        const mode = definition.lifecycle ?? "lazy";
        return mode === "keep-alive" || mode === "eager";
      });

  if (ctx.hasUI && startupServers.length > 0) {
    ctx.ui.setStatus("mcp", `MCP: connecting to ${startupServers.length} servers...`);
  }

  // 第四阶段：限制并发连接启动 Server，避免同时拉起过多子进程或网络握手。
  const results = await parallelLimit(startupServers, 10, async ([name, definition]) => {
    try {
      const connection = await manager.connect(name, definition, ctx.signal);
      if (connection.status === "needs-auth") {
        return { name, definition, connection: null, error: `OAuth authentication required. Run /mcp-auth ${name}.` };
      }
      return { name, definition, connection, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name, definition, connection: null, error: message };
    }
  });

  // 连接成功后把 SDK tools/resources 转成统一 ToolMetadata，并立刻刷新磁盘缓存。
  for (const { name, definition, connection, error } of results) {
    if (error || !connection) {
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to connect to ${name}: ${error}`, "error");
      }
      console.error(`MCP: Failed to connect to ${name}: ${error}`);
      continue;
    }

    const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
    toolMetadata.set(name, metadata);
    updateMetadataCache(state, name);

    if (failedTools.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `MCP: ${name} - ${failedTools.length} tools skipped`,
        "warning"
      );
    }
  }

  const connectedCount = results.filter(r => r.connection).length;
  const failedCount = results.filter(r => r.error).length;
  if (ctx.hasUI && connectedCount > 0) {
    const totalTools = totalToolCount(state);
    const msg = failedCount > 0
      ? `MCP: ${connectedCount}/${startupServers.length} servers connected (${totalTools} tools)`
      : `MCP: ${connectedCount} servers connected (${totalTools} tools)`;
    ctx.ui.notify(msg, "info");
  }

  // direct tools 必须在扩展注册阶段拥有 Schema；缓存缺失时这里只负责 bootstrap，重启后才会注册直连工具。
  const envDirect = process.env.MCP_DIRECT_TOOLS;
  if (envDirect !== "__none__") {
    const currentCache = loadMetadataCache();
    const missingCacheServers = getMissingConfiguredDirectToolServers(config, currentCache);

    if (missingCacheServers.length > 0) {
      const bootstrapResults = await parallelLimit(
        missingCacheServers.filter(name => !results.some(r => r.name === name && r.connection)),
        10,
        async (name) => {
          const definition = config.mcpServers[name];
          try {
            const connection = await manager.connect(name, definition, ctx.signal);
            if (connection.status === "needs-auth") {
              return { name, ok: false };
            }
            const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
            toolMetadata.set(name, metadata);
            updateMetadataCache(state, name);
            return { name, ok: true };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(`MCP: direct-tools bootstrap failed for ${name}: ${message}`);
            return { name, ok: false };
          }
        },
      );
      const bootstrapped = bootstrapResults.filter(r => r.ok).map(r => r.name);
      if (bootstrapped.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`MCP: direct tools for ${bootstrapped.join(", ")} will be available after restart`, "info");
      }
    }
  }

  // 第五阶段：健康检查重连后同步元数据；普通 Server 空闲关闭后只更新状态栏，缓存仍可用于发现。
  lifecycle.setReconnectCallback((serverName) => {
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
  });

  lifecycle.setIdleShutdownCallback((serverName) => {
    const idleMinutes = getEffectiveIdleTimeoutMinutes(state, serverName);
    logger.debug(`${serverName} shut down (idle ${idleMinutes}m)`);
    updateStatusBar(state);
  });

  lifecycle.startHealthChecks();

  return state;
}

/** 从健康连接的 tools/resources 重建指定 Server 的内存发现索引。 */
export function updateServerMetadata(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const prefix = state.config.settings?.toolPrefix ?? "server";

  const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
  state.toolMetadata.set(serverName, metadata);
}

/**
 * 把健康连接的最小工具/资源快照写入磁盘。若本次 Server 没返回 resources，但配置指纹未变，
 * 保留旧资源快照，避免暂时性 listResources 失败清空仍有效的 Resource Tool。
 */
export function updateMetadataCache(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const configHash = computeServerHash(definition);
  const existing = loadMetadataCache();
  const existingEntry = existing?.servers?.[serverName];

  const tools = serializeTools(connection.tools);
  let resources = definition.exposeResources === false ? [] : serializeResources(connection.resources);

  if (
    definition.exposeResources !== false &&
    resources.length === 0 &&
    existingEntry?.resources?.length &&
    existingEntry.configHash === configHash
  ) {
    resources = existingEntry.resources;
  }

  const entry: ServerCacheEntry = {
    configHash,
    tools,
    resources,
    cachedAt: Date.now(),
  };

  saveMetadataCache({ version: 1, servers: { [serverName]: entry } });
}

/** 会话关闭前把所有健康连接的最新发现结果刷新到持久化缓存。 */
export function flushMetadataCache(state: McpExtensionState): void {
  for (const [name, connection] of state.manager.getAllConnections()) {
    if (connection.status === "connected") {
      updateMetadataCache(state, name);
    }
  }
}

/** 用“已连接数/配置总数”更新状态栏；它展示连接状态，不展示缓存可发现状态。 */
export function updateStatusBar(state: McpExtensionState): void {
  const ui = state.ui;
  if (!ui) return;
  const total = Object.keys(state.config.mcpServers).length;
  if (total === 0) {
    ui.setStatus("mcp", undefined);
    return;
  }
  const connectedCount = state.manager.getAllConnections().size;
  ui.setStatus("mcp", ui.theme.fg("accent", `MCP: ${connectedCount}/${total} servers`));
}

/** 返回仍处于一分钟失败退避窗口内的失败年龄；窗口过期后返回 null，允许再次连接。 */
export function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
  const failedAt = state.failureTracker.get(serverName);
  if (!failedAt) return null;
  const ageMs = Date.now() - failedAt;
  if (ageMs > FAILURE_BACKOFF_MS) return null;
  return Math.round(ageMs / 1000);
}

/**
 * connect/call 共用的按需连接入口。依次处理 needs-auth、健康连接复用、失败退避和新建连接；
 * 成功后原子地刷新内存元数据、磁盘缓存和状态栏，普通失败记录退避时间。
 */
export async function lazyConnect(state: McpExtensionState, serverName: string, signal?: AbortSignal): Promise<boolean> {
  // needs-auth 必须交给上层 OAuth 流程；健康连接只刷新索引，不重复握手。
  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    return false;
  }
  if (connection?.status === "connected") {
    updateServerMetadata(state, serverName);
    return true;
  }

  // 退避窗口内直接失败，防止连续 Tool 调用造成连接风暴。
  const failedAgo = getFailureAgeSeconds(state, serverName);
  if (failedAgo !== null) return false;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return false;

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    // manager.connect 内部再负责健康连接复用与并发连接 Promise 去重。
    const newConnection = await state.manager.connect(serverName, definition, signal);
    if (newConnection.status === "needs-auth") {
      return false;
    }
    state.failureTracker.delete(serverName);
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    updateStatusBar(state);
    return true;
  } catch (error) {
    if (signal?.aborted) {
      throwIfAborted(signal);
    }
    state.failureTracker.set(serverName, Date.now());
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`MCP: lazy connect failed for ${serverName}: ${message}`);
    updateStatusBar(state);
    return false;
  }
}

/** 解析 Server 级、生命周期模式和全局配置的最终空闲超时；eager 默认不回收。 */
function getEffectiveIdleTimeoutMinutes(state: McpExtensionState, serverName: string): number {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
  }
  if (typeof definition.idleTimeout === "number") return definition.idleTimeout;
  const mode = definition.lifecycle ?? "lazy";
  if (mode === "eager") return 0;
  return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
}
