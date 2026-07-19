import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata, McpTool, McpResource, ServerEntry } from "./types.ts";
import { formatToolName, isToolExcluded } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { extractToolUiStreamMode } from "./utils.ts";

/**
 * 把 MCP SDK 返回的 tools/resources 转换为 Proxy 统一使用的 ToolMetadata。
 * 此处应用工具名前缀、excludeTools、MCP App UI 元数据，并把 Resource 映射成只读 Tool。
 */
export function buildToolMetadata(
  tools: McpTool[],
  resources: McpResource[],
  definition: ServerEntry,
  serverName: string,
  prefix: "server" | "none" | "short"
): { metadata: ToolMetadata[]; failedTools: string[] } {
  const metadata: ToolMetadata[] = [];
  const failedTools: string[] = [];

  // 普通 MCP Tool 保留原始名用于 callTool，同时生成 Agent 侧可见的格式化名称。
  for (const tool of tools) {
    if (!tool?.name) {
      failedTools.push("(unnamed)");
      continue;
    }
    if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) {
      continue;
    }

    let uiResourceUri: string | undefined;
    try {
      uiResourceUri = getToolUiResourceUri({ _meta: tool._meta });
    } catch {
      failedTools.push(tool.name);
    }
    metadata.push({
      name: formatToolName(tool.name, serverName, prefix),
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      uiResourceUri,
      uiStreamMode: extractToolUiStreamMode(tool._meta),
    });
  }

  // Resource 不具备 callTool Schema，因此映射成无参数的 get_* Tool，执行时改走 readResource。
  if (definition.exposeResources !== false) {
    for (const resource of resources) {
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

  return { metadata, failedTools };
}

/** 返回指定 Server 的 Agent 可见工具名；只读元数据，不要求当前连接在线。 */
export function getToolNames(state: McpExtensionState, serverName: string): string[] {
  return state.toolMetadata.get(serverName)?.map(m => m.name) ?? [];
}

/** 统计所有 Server 发现索引中的工具数，用于状态提示。 */
export function totalToolCount(state: McpExtensionState): number {
  let count = 0;
  for (const metadata of state.toolMetadata.values()) {
    count += metadata.length;
  }
  return count;
}

/** 优先精确匹配；找不到时把连字符视为下划线，提高模型生成工具名时的容错性。 */
export function findToolByName(metadata: ToolMetadata[] | undefined, toolName: string): ToolMetadata | undefined {
  if (!metadata) return undefined;
  const exact = metadata.find(m => m.name === toolName);
  if (exact) return exact;
  const normalized = toolName.replace(/-/g, "_");
  return metadata.find(m => m.name.replace(/-/g, "_") === normalized);
}

/**
 * 把 JSON Schema 转成适合模型快速阅读的紧凑文本，而不是把原始 Schema 整段序列化进上下文。
 * 支持 object properties、required、数组 items、anyOf/oneOf 和常用约束注解。
 */
export function formatSchema(schema: unknown, indent = "  "): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return `${indent}(no schema)`;
  }

  const s = schema as Record<string, unknown>;

  if (s.type === "object" && s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
    const props = s.properties as Record<string, unknown>;
    const required = Array.isArray(s.required) ? s.required.filter((name): name is string => typeof name === "string") : [];

    if (Object.keys(props).length === 0) {
      return `${indent}(no parameters)`;
    }

    const lines: string[] = [];
    for (const [name, propSchema] of Object.entries(props)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
    }
    return lines.join("\n");
  }

  const lines = formatNestedSchema(s, indent);
  if (lines.length > 0) {
    return lines.join("\n");
  }

  const typeStr = formatType(s);
  if (typeStr) {
    return `${indent}(${typeStr})`;
  }

  return `${indent}(complex schema)`;
}

/** 格式化单个属性，并递归展开它的嵌套结构。 */
function formatProperty(name: string, schema: unknown, required: boolean, indent: string): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [`${indent}${name}${required ? " *required*" : ""}`];
  }

  const s = schema as Record<string, unknown>;
  const parts = [`${indent}${name}`];
  const typeStr = formatType(s);
  if (typeStr) parts.push(`(${typeStr})`);
  if (required) parts.push("*required*");
  appendSchemaAnnotations(parts, s);

  return [parts.join(" "), ...formatNestedSchema(s, `${indent}  `)];
}

/** 展开组合类型、数组元素和嵌套对象属性。 */
function formatNestedSchema(schema: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];

  if (Array.isArray(schema.anyOf)) {
    lines.push(...formatVariants("anyOf", schema.anyOf, indent));
  }
  if (Array.isArray(schema.oneOf)) {
    lines.push(...formatVariants("oneOf", schema.oneOf, indent));
  }
  if (schema.items !== undefined) {
    lines.push(...formatProperty("items", schema.items, false, indent));
  }
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
    for (const [name, propSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
    }
  }

  return lines;
}

/** 把 anyOf/oneOf 的每个候选 Schema 格式化为缩进列表。 */
function formatVariants(keyword: "anyOf" | "oneOf", variants: unknown[], indent: string): string[] {
  const lines = [`${indent}${keyword}:`];

  for (const variant of variants) {
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
      lines.push(`${indent}  - ${JSON.stringify(variant)}`);
      continue;
    }

    const s = variant as Record<string, unknown>;
    const typeStr = formatType(s) || "schema";
    const parts = [`${indent}  - ${typeStr}`];
    appendSchemaAnnotations(parts, s);
    lines.push(parts.join(" "));
    lines.push(...formatNestedSchema(s, `${indent}    `));
  }

  return lines;
}

/** 按 const、enum、显式 type、结构推断的优先级生成人类可读类型。 */
function formatType(schema: Record<string, unknown>): string {
  if (Object.hasOwn(schema, "const")) {
    return `const ${JSON.stringify(schema.const)}`;
  }

  if (Array.isArray(schema.enum)) {
    return `enum: ${schema.enum.map(v => JSON.stringify(v)).join(", ")}`;
  }

  if (Array.isArray(schema.type)) {
    return schema.type.map(type => String(type)).join(" | ");
  }

  if (schema.type) {
    return String(schema.type);
  }

  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    return "object";
  }

  if (schema.items !== undefined) {
    return "array";
  }

  return "";
}

/** 追加 description、长度/数值约束、format、pattern 和 default 等常用 Schema 注解。 */
function appendSchemaAnnotations(parts: string[], schema: Record<string, unknown>): void {
  if (schema.description && typeof schema.description === "string") {
    parts.push(`- ${schema.description}`);
  }

  for (const key of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "format", "pattern"] as const) {
    if (schema[key] !== undefined) {
      parts.push(`[${key}: ${JSON.stringify(schema[key])}]`);
    }
  }

  if (schema.default !== undefined) {
    parts.push(`[default: ${JSON.stringify(schema.default)}]`);
  }
}
