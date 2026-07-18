import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ElicitationCompleteNotificationSchema,
  type ReadResourceResult,
  type UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpTool,
  McpResource,
  ServerDefinition,
  ServerStreamResultPatchNotification,
  Transport,
} from "./types.ts";
import { serverStreamResultPatchNotificationSchema } from "./types.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { logger } from "./logger.ts";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { extractOAuthConfig, supportsOAuth } from "./mcp-auth-flow.ts";
import { registerSamplingHandler, type ServerSamplingConfig } from "./sampling-handler.ts";
import {
  handleUrlElicitation,
  registerElicitationHandler,
  type ServerElicitationConfig,
} from "./elicitation-handler.ts";
import { interpolateEnvRecord, resolveBearerToken, resolveConfigPath } from "./utils.ts";
import { abortable, throwIfAborted } from "./abort.ts";

/** 一个可复用 MCP 连接的完整运行时状态。 */
interface ServerConnection {
  /** 已完成 MCP 握手的 SDK 客户端。 */
  client: Client;
  /** 客户端使用的 stdio、Streamable HTTP 或 SSE 底层传输；关闭时必须与 client 一起释放。 */
  transport: Transport;
  /** 建立此连接所用配置，用于请求超时等后续行为。 */
  definition: ServerDefinition;
  /** 连接建立时从所有分页中发现的工具。 */
  tools: McpTool[];
  /** 连接建立时从所有分页中发现的资源。 */
  resources: McpResource[];
  /** 最近一次连接、读取或调用完成时的 Unix 毫秒时间戳。 */
  lastUsedAt: number;
  /** 当前尚未结束的读取或工具调用数；大于零时禁止空闲回收。 */
  inFlight: number;
  /** needs-auth 是可恢复状态，不等同于普通连接失败。 */
  status: "connected" | "closed" | "needs-auth";
}

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;

export class McpServerManager {
  // connections 保存已完成连接；connectPromises 保存建立中的连接，用于合并并发 connect 请求。
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  private samplingConfig: ServerSamplingConfig | undefined;
  private elicitationConfig: ServerElicitationConfig | undefined;
  private acceptedUrlElicitations = new Map<string, Set<string>>();
  private defaultRequestTimeoutMs: number | undefined;

  /** Default cwd for stdio servers without an explicit config `cwd`. */
  constructor(private readonly defaultCwd?: string) {}

  setSamplingConfig(config: ServerSamplingConfig | undefined): void {
    this.samplingConfig = config;
  }

  setElicitationConfig(config: ServerElicitationConfig | undefined): void {
    this.elicitationConfig = config;
  }

  setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void {
    this.defaultRequestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  }

  getRequestOptions(name: string, signal?: AbortSignal): RequestOptions | undefined {
    const connection = this.connections.get(name);
    return this.buildRequestOptions(connection?.definition, signal);
  }

  private getResolvedRequestTimeoutMs(definition?: ServerDefinition): number | undefined {
    if (definition?.requestTimeoutMs !== undefined) {
      return normalizeRequestTimeoutMs(definition.requestTimeoutMs);
    }
    return this.defaultRequestTimeoutMs;
  }

  private buildRequestOptions(
    definition?: ServerDefinition,
    signal?: AbortSignal,
  ): RequestOptions | undefined {
    const timeout = this.getResolvedRequestTimeoutMs(definition);

    if (!signal && timeout === undefined) {
      return undefined;
    }

    return {
      ...(signal ? { signal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  /** 复用健康连接，并让同一服务的并发连接请求等待同一个 Promise，避免重复启动进程或握手。 */
  async connect(name: string, definition: ServerDefinition, signal?: AbortSignal): Promise<ServerConnection> {
    throwIfAborted(signal);
    // 同名服务正在连接时直接复用 Promise；每个调用者仍可用自己的 signal 放弃等待。
    if (this.connectPromises.has(name)) {
      return abortable(this.connectPromises.get(name)!, signal);
    }

    // 已有健康连接直接复用，并刷新空闲计时。
    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const promise = this.createConnection(name, definition, signal);
    this.connectPromises.set(name, promise);

    try {
      const connection = await promise;
      this.connections.set(name, connection);
      return connection;
    } finally {
      this.connectPromises.delete(name);
    }
  }

  /** 根据 ServerDefinition 选择 transport，完成握手，并一次性发现全部工具与资源。 */
  private async createConnection(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    throwIfAborted(signal);
    const client = this.createClient(name);

    let transport: Transport;

    if (definition.command) {
      // 本地命令型服务使用 stdio；npx/npm 会先解析真实二进制，减少多余父进程。
      let command = definition.command;
      let args = definition.args ?? [];

      if (command === "npx" || command === "npm") {
        const resolved = await resolveNpxBinary(command, args);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
        }
      }

      transport = new StdioClientTransport({
        command,
        args,
        env: resolveEnv(definition.env),
        cwd: resolveConfigPath(definition.cwd) ?? this.defaultCwd,
        stderr: definition.debug ? "inherit" : "ignore",
      });
    } else if (definition.url) {
      // URL 型服务优先使用现代 Streamable HTTP，失败后按规则回退到旧 SSE。
      transport = await this.createHttpTransport(definition, name, signal);
    } else {
      throw new Error(`Server ${name} has no command or url`);
    }

    const requestOptions = this.buildRequestOptions(definition, signal);

    try {
      await client.connect(transport, requestOptions);
      this.attachAdapterNotificationHandlers(name, client);

      // 连接成功后并行拉取工具和资源；结果留在连接对象中供元数据层构建索引。
      const [tools, resources] = await Promise.all([
        this.fetchAllTools(client, requestOptions),
        this.fetchAllResources(client, requestOptions),
      ]);

      return {
        client,
        transport,
        definition,
        tools,
        resources,
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      };
    } catch (error) {
      // 支持 OAuth 的服务把 401 转成 needs-auth，让上层进入认证流程，而不是当作永久失败。
      if (error instanceof UnauthorizedError && supportsOAuth(definition)) {
        // Clean up both client and transport before reporting needs-auth.
        await client.close().catch(() => {});
        await transport.close().catch(() => {});

        return {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
        };
      }

      // 普通失败必须同时关闭 client 与 transport，避免泄漏子进程、socket 或事件监听器。
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }

  private buildClientCapabilities() {
    return {
      ...(this.samplingConfig ? { sampling: {} } : {}),
      ...(this.elicitationConfig
        ? {
            elicitation: {
              form: {},
              ...(this.elicitationConfig.allowUrl ? { url: {} } : {}),
            },
          }
        : {}),
    };
  }

  private createClient(serverName: string): Client {
    const capabilities = this.buildClientCapabilities();
    const client = new Client(
      { name: `pi-mcp-${serverName}`, version: "1.0.0" },
      Object.keys(capabilities).length > 0 ? { capabilities } : undefined,
    );
    if (this.samplingConfig) {
      registerSamplingHandler(client, { ...this.samplingConfig, serverName });
    }
    if (this.elicitationConfig) {
      registerElicitationHandler(client, {
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      });
      if (this.elicitationConfig.allowUrl) {
        client.setNotificationHandler(ElicitationCompleteNotificationSchema, notification => {
          const accepted = this.acceptedUrlElicitations.get(serverName);
          if (!accepted?.delete(notification.params.elicitationId)) return;
          this.elicitationConfig?.ui.notify(
            `MCP browser interaction for ${serverName} completed. You can retry the tool now.`,
            "info",
          );
        });
      }
    }
    return client;
  }

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
  ): Promise<"accept" | "decline" | "cancel"> {
    if (!this.elicitationConfig?.allowUrl) return "cancel";
    for (const params of error.elicitations) {
      const result = await handleUrlElicitation({
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      }, params);
      if (result.action !== "accept") return result.action;
    }
    return "accept";
  }

  private rememberUrlElicitation(serverName: string, elicitationId: string): void {
    let accepted = this.acceptedUrlElicitations.get(serverName);
    if (!accepted) {
      accepted = new Set();
      this.acceptedUrlElicitations.set(serverName, accepted);
    }
    accepted.add(elicitationId);
  }

  /**
   * 创建远程 transport：先探测 Streamable HTTP；只有协议不兼容时才回退 SSE。
   * 认证失败和主动取消不是协议不兼容，不能触发 SSE 回退。
   */
  private async createHttpTransport(
    definition: ServerDefinition,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<Transport> {
    throwIfAborted(signal);
    const url = new URL(definition.url!);

    // Build headers first (including any bearer token)
    const headers = resolveHeaders(definition.headers) ?? {};

    // For bearer auth, add the token to headers BEFORE creating requestInit
    if (definition.auth === "bearer") {
      const token = resolveBearerToken(definition);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    // Create request init with headers (Authorization now included for bearer auth)
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

    // For OAuth servers, create an auth provider
    let authProvider: McpOAuthProvider | undefined;
    if (supportsOAuth(definition)) {
      const oauthConfig = extractOAuthConfig(definition);
      authProvider = new McpOAuthProvider(
        serverName,
        definition.url!,
        oauthConfig,
        {
          onRedirect: async (_authUrl) => {
            // URL is captured by startAuth, no need to log
          },
        }
      );
    }

    // 现代 MCP Server 首选 Streamable HTTP。
    const streamableTransport = new StreamableHTTPClientTransport(url, {
      requestInit,
      authProvider,
    });

    try {
      // 用短生命周期 probe 验证 transport，再为正式 client 创建全新 transport。
      const testClient = new Client({ name: "pi-mcp-probe", version: "2.1.2" });
      await testClient.connect(streamableTransport, this.buildRequestOptions(definition, signal));
      await testClient.close().catch(() => {});
      // Close probe transport before creating fresh one
      await streamableTransport.close().catch(() => {});

      // StreamableHTTP works - create fresh transport for actual use
      return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
    } catch (error) {
      // 探测失败先清理；确认不是取消或认证问题后才尝试 SSE。
      await streamableTransport.close().catch(() => {});

      // Host cancellation is not transport capability evidence; do not fall
      // through to SSE when the caller is trying to cancel the connect.
      if (signal?.aborted) {
        throwIfAborted(signal);
      }

      // If this was an UnauthorizedError, don't try SSE - the server needs auth
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      // SSE 是兼容旧 MCP Server 的兜底 transport。
      return new SSEClientTransport(url, { requestInit, authProvider });
    }
  }

  /** 跟随 nextCursor 拉完所有工具页，避免发现结果被服务端分页截断。 */
  private async fetchAllTools(client: Client, requestOptions?: RequestOptions): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return allTools;
  }

  /** 拉取全部资源；服务不支持 resources 时返回空数组，但主动取消仍向上抛出。 */
  private async fetchAllResources(client: Client, requestOptions?: RequestOptions): Promise<McpResource[]> {
    try {
      const allResources: McpResource[] = [];
      let cursor: string | undefined;

      do {
        const result = await client.listResources(cursor ? { cursor } : undefined, requestOptions);
        allResources.push(...(result.resources ?? []));
        cursor = result.nextCursor;
      } while (cursor);

      return allResources;
    } catch {
      if (requestOptions?.signal?.aborted) {
        throwIfAborted(requestOptions.signal);
      }
      // Server may not support resources
      return [];
    }
  }

  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    client.setNotificationHandler(serverStreamResultPatchNotificationSchema, (notification) => {
      const listener = this.uiStreamListeners.get(notification.params.streamToken);
      if (!listener) return;
      listener(serverName, notification.params);
    });
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.readResource({ uri }, this.getRequestOptions(name, signal));
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }

  /** 从复用池摘除连接后再异步关闭底层资源，避免误删同时新建的同名连接。 */
  async close(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;

    // 必须先从 Map 删除再 await 清理。否则并发 connect() 可能放入新连接，旧清理流程随后把新连接误删。
    connection.status = "closed";
    this.connections.delete(name);
    this.acceptedUrlElicitations.delete(name);
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map(name => this.close(name)));
  }

  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.lastUsedAt = Date.now();
    }
  }

  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.inFlight = (connection.inFlight ?? 0) + 1;
    }
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) {
      connection.inFlight--;
    }
  }

  /** 只有健康、没有执行中请求且超过阈值的连接才算空闲。 */
  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return false;
    if (connection.inFlight > 0) return false;
    return (Date.now() - connection.lastUsedAt) > timeoutMs;
  }
}

/**
 * Resolve environment variables with interpolation.
 */
function resolveEnv(env?: Record<string, string>): Record<string, string> {
  // Copy process.env, filtering out undefined values
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      resolved[key] = value;
    }
  }

  if (!env) return resolved;

  const overrides = interpolateEnvRecord(env);
  return overrides ? { ...resolved, ...overrides } : resolved;
}

/**
 * Resolve headers with environment variable interpolation.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  return interpolateEnvRecord(headers);
}

function normalizeRequestTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : undefined;
}
