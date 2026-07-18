// metadata-cache.ts - Persistent MCP metadata cache
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import { createHash } from "node:crypto";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpTool, McpResource, ServerEntry, ToolMetadata } from "./types.ts";
import { formatToolName, isToolExcluded } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { extractToolUiStreamMode, interpolateEnvRecord, resolveBearerToken, resolveConfigPath } from "./utils.ts";

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 磁盘中保存的最小工具快照；足以支持离线 search/list/describe，无需常驻真实连接。 */
export interface CachedTool {
  /** MCP Server 暴露的原始工具名。 */
  name: string;
  /** 工具用途说明，供 search/list/describe 展示和检索。 */
  description?: string;
  /** 工具参数的 JSON Schema；仅在需要展示或调用时使用。 */
  inputSchema?: unknown;
  /** 与工具关联的 MCP App UI 资源地址。 */
  uiResourceUri?: string;
  /** UI 结果流模式：立即打开 UI，或等首个流事件后再打开。 */
  uiStreamMode?: "eager" | "stream-first";
}

/** 可被映射成只读工具的 MCP Resource 快照。 */
export interface CachedResource {
  /** MCP Resource 的唯一 URI，也是实际读取资源时的定位符。 */
  uri: string;
  /** Resource 原始名称，用来生成映射后的工具名。 */
  name: string;
  /** Resource 的用途说明；缺失时会用 URI 生成默认描述。 */
  description?: string;
}

/** 单个 MCP Server 的缓存单元。configHash 与 cachedAt 共同决定它能否复用。 */
export interface ServerCacheEntry {
  /** 会影响工具/资源集合的服务配置指纹。 */
  configHash: string;
  /** 该服务最近一次成功发现的工具快照。 */
  tools: CachedTool[];
  /** 该服务最近一次成功发现的资源快照。 */
  resources: CachedResource[];
  /** 写入此快照的 Unix 毫秒时间戳，用于 TTL 判断。 */
  cachedAt: number;
}

/** 整份持久化缓存的领域模型；version 用于拒绝不兼容的旧格式。 */
export interface MetadataCache {
  /** 缓存文件格式版本。 */
  version: number;
  /** 按配置中的 MCP Server 名称索引缓存单元。 */
  servers: Record<string, ServerCacheEntry>;
}

export function getMetadataCachePath(): string {
  return getAgentPath("mcp-cache.json");
}

/** 从 Agent 目录读取缓存；文件缺失、格式损坏或版本不匹配都按无缓存处理。 */
export function loadMetadataCache(): MetadataCache | null {
  const cachePath = getMetadataCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    if (raw.version !== CACHE_VERSION) return null;
    if (!raw.servers || typeof raw.servers !== "object") return null;
    return raw as MetadataCache;
  } catch {
    return null;
  }
}

/**
 * 合并写入缓存。先写同目录临时文件再 rename，避免进程中断留下半份 JSON；
 * 合并已有 servers，避免多个初始化流程互相覆盖不相关服务。
 */
export function saveMetadataCache(cache: MetadataCache): void {
  const cachePath = getMetadataCachePath();
  const dir = dirname(cachePath);
  mkdirSync(dir, { recursive: true });

  let merged: MetadataCache = { version: CACHE_VERSION, servers: {} };
  try {
    if (existsSync(cachePath)) {
      const existing = JSON.parse(readFileSync(cachePath, "utf-8")) as MetadataCache;
      if (existing && existing.version === CACHE_VERSION && existing.servers) {
        merged.servers = { ...existing.servers };
      }
    }
  } catch {
    // Ignore parse errors and proceed with empty cache
  }

  merged.version = CACHE_VERSION;
  merged.servers = { ...merged.servers, ...cache.servers };

  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmpPath, cachePath);
}

/** 计算服务身份指纹。只纳入会改变工具/资源暴露结果的配置。 */
export function computeServerHash(definition: ServerEntry): string {
  // lifecycle、idleTimeout、requestTimeoutMs、debug 只影响运行行为，不影响 Schema，因此不参与哈希。
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    env: interpolateEnvRecord(definition.env),
    cwd: resolveConfigPath(definition.cwd),
    url: definition.url,
    headers: interpolateEnvRecord(definition.headers),
    auth: definition.auth,
    bearerToken: resolveBearerToken(definition),
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
    excludeTools: definition.excludeTools,
  };
  const normalized = stableStringify(identity);
  return createHash("sha256").update(normalized).digest("hex");
}

/** 缓存只有在配置指纹一致、时间戳合法且未超过 TTL 时才有效。 */
export function isServerCacheValid(
  entry: ServerCacheEntry,
  definition: ServerEntry,
  maxAgeMs: number = CACHE_MAX_AGE_MS
): boolean {
  if (!entry || entry.configHash !== computeServerHash(definition)) return false;
  if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false;
  if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return false;
  return true;
}

/**
 * 把磁盘快照重建为运行时 ToolMetadata，并在重建时应用前缀、排除规则和 Resource-to-Tool 映射。
 */
export function reconstructToolMetadata(
  serverName: string,
  entry: ServerCacheEntry,
  prefix: "server" | "none" | "short",
  definition: Pick<ServerEntry, "exposeResources" | "excludeTools">
): ToolMetadata[] {
  const metadata: ToolMetadata[] = [];

  for (const tool of entry.tools ?? []) {
    if (!tool?.name) continue;
    if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) {
      continue;
    }

    metadata.push({
      name: formatToolName(tool.name, serverName, prefix),
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      uiResourceUri: tool.uiResourceUri,
      uiStreamMode: tool.uiStreamMode,
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of entry.resources ?? []) {
      if (!resource?.name || !resource?.uri) continue;
      const baseName = `get_${resourceNameToToolName(resource.name)}`;
      if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) {
        continue;
      }

      metadata.push({
        name: formatToolName(baseName, serverName, prefix),
        originalName: baseName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        resourceUri: resource.uri,
      });
    }
  }

  return metadata;
}

/** 从 SDK 返回值抽取发现流程需要的最小工具字段，供后续离线发现。 */
export function serializeTools(tools: McpTool[]): CachedTool[] {
  return tools
    .filter(t => t?.name)
    .map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      uiResourceUri: tryGetToolUiResourceUri(t),
      uiStreamMode: extractToolUiStreamMode(t._meta),
    }));
}

/** 从 SDK 返回值抽取最小 Resource 字段。 */
export function serializeResources(resources: McpResource[]): CachedResource[] {
  return resources
    .filter(r => r?.name && r?.uri)
    .map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
    }));
}

/** 递归排序对象键，保证语义相同但键顺序不同的配置得到同一哈希。 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "undefined" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function tryGetToolUiResourceUri(tool: McpTool): string | undefined {
  try {
    return getToolUiResourceUri({ _meta: tool._meta });
  } catch {
    return undefined;
  }
}
