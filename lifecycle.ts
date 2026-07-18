import type { ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { logger } from "./logger.ts";

/** keep-alive 服务重连成功后的通知，用来刷新该服务的工具元数据。 */
export type ReconnectCallback = (serverName: string) => void;

/** 负责健康检查、keep-alive 自动重连、普通连接空闲回收和最终关闭。 */
export class McpLifecycleManager {
  private manager: McpServerManager;
  private keepAliveServers = new Map<string, ServerDefinition>();
  private allServers = new Map<string, ServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout: number = 10 * 60 * 1000;
  private healthCheckInterval?: NodeJS.Timeout;
  private onReconnect?: ReconnectCallback;
  private onIdleShutdown?: (serverName: string) => void;
  
  constructor(manager: McpServerManager) {
    this.manager = manager;
  }
  
  /** 设置自动重连成功回调；扩展层借此刷新工具元数据与缓存。 */
  setReconnectCallback(callback: ReconnectCallback): void {
    this.onReconnect = callback;
  }
  
  /** 标记必须常驻的服务；健康检查发现断线时会尝试重连。 */
  markKeepAlive(name: string, definition: ServerDefinition): void {
    this.keepAliveServers.set(name, definition);
  }

  /** 注册可被生命周期管理的服务及其可选空闲超时。 */
  registerServer(name: string, definition: ServerDefinition, settings?: { idleTimeout?: number }): void {
    this.allServers.set(name, definition);
    if (settings?.idleTimeout !== undefined) {
      this.serverSettings.set(name, settings);
    }
  }

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleTimeout = minutes * 60 * 1000;
  }

  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }
  
  /** 启动后台巡检；unref 使定时器不会单独阻止 Node.js 进程退出。 */
  startHealthChecks(intervalMs = 30000): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkConnections();
    }, intervalMs);
    this.healthCheckInterval.unref();
  }
  
  /** 一轮巡检先恢复 keep-alive 服务，再回收非 keep-alive 的空闲连接。 */
  private async checkConnections(): Promise<void> {
    for (const [name, definition] of this.keepAliveServers) {
      const connection = this.manager.getConnection(name);
      
      if (!connection || connection.status !== "connected") {
        try {
          await this.manager.connect(name, definition);
          logger.debug(`Reconnected to ${name}`);
          // 重连会重新发现工具，通知扩展层同步新的元数据。
          this.onReconnect?.(name);
        } catch (error) {
          console.error(`MCP: Failed to reconnect to ${name}:`, error);
        }
      }
    }

    for (const [name] of this.allServers) {
      if (this.keepAliveServers.has(name)) continue;
      const timeout = this.getIdleTimeout(name);
      if (timeout > 0 && this.manager.isIdle(name, timeout)) {
        await this.manager.close(name);
        this.onIdleShutdown?.(name);
      }
    }
  }

  /** 服务级 idleTimeout 优先；配置单位为分钟，这里统一换算为毫秒。 */
  private getIdleTimeout(name: string): number {
    const perServer = this.serverSettings.get(name)?.idleTimeout;
    if (perServer !== undefined) return perServer * 60 * 1000;
    return this.globalIdleTimeout;
  }
  
  /** 停止巡检并并行关闭所有底层连接。 */
  async gracefulShutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    await this.manager.closeAll();
  }
}
