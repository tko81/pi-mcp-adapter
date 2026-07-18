import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, McpSettings } from "./types.ts";

export const DEFAULT_MCP_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MCP_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_MCP_DETAILS_MAX_BYTES = 16 * 1024;

const CONTENT_SUMMARY_LIMIT = 20;
const KEY_PREVIEW_LIMIT = 20;
const KEY_MAX_CHARS = 120;

type Recordish = Record<string, unknown>;

/** 文本被截断时返回给上层的度量与完整内容落盘位置。 */
export interface McpOutputGuardDetails {
  /** 固定为 true，表示模型看到的文本不是完整输出。 */
  truncated: true;
  /** 完整文本的 UTF-8 字节数。 */
  originalBytes: number;
  /** 截断提示拼接完成后，实际返回文本的 UTF-8 字节数。 */
  returnedBytes: number;
  /** 完整文本的总行数。 */
  originalLines: number;
  /** 截断后实际返回文本的总行数。 */
  returnedLines: number;
  /** 文本截断时仍原样透传的图片块数量。 */
  imageBlocksPassedThrough?: number;
  /** 完整文本成功落盘后的临时文件绝对路径。 */
  fullOutputPath?: string;
  /** 完整文本落盘失败时的错误信息。 */
  writeError?: string;
}

/** 原始 details.mcpResult 过大时使用的有界摘要，避免结构化结果绕过文本限制。 */
export interface McpResultSummary {
  /** 固定为 true，表示原始 MCP 结果已从 details 中省略。 */
  omitted: true;
  /** 省略原始结果的原因说明。 */
  reason: string;
  /** 原始 MCP 结果是否声明工具执行失败。 */
  isError: boolean;
  /** 原始结果中 content block 的总数。 */
  contentBlocks: number;
  /** 前若干个 content block 的有界类型与大小摘要。 */
  contentSummary: Array<Record<string, unknown>>;
  /** structuredContent 的键和估算大小摘要，不包含原始大字段值。 */
  structuredContent?: Record<string, unknown>;
  /** MCP `_meta` 的键和估算大小摘要。 */
  meta?: Record<string, unknown>;
  /** 标准字段之外其他顶层字段的名称、类型和估算大小。 */
  extraFields?: Array<Record<string, unknown>>;
  /** 序列化后完整 MCP 结果的 UTF-8 字节数。 */
  rawResultBytes: number;
  /** 完整 MCP 结果成功落盘后的临时文件绝对路径。 */
  fullResultPath?: string;
  /** 完整 MCP 结果落盘失败时的错误信息。 */
  resultWriteError?: string;
}

/** 单次输出保护策略；prefix/suffix 也计入字节数和行数预算。 */
export interface McpOutputGuardOptions {
  /** 是否启用输出保护；false 时文本与原始结果都不截断。 */
  enabled?: boolean;
  /** 加在第一个文本块之前的内容，也计入文本预算。 */
  prefix?: string;
  /** 加在最后一个文本块之后的内容，也计入文本预算。 */
  suffix?: string;
  /** 没有可展示文本时使用的兜底消息。 */
  emptyTextFallback?: string;
  /** 模型可见文本允许的最大 UTF-8 字节数。 */
  maxBytes?: number;
  /** 模型可见文本允许的最大行数。 */
  maxLines?: number;
  /** details.mcpResult 序列化后允许的最大 UTF-8 字节数。 */
  detailsMaxBytes?: number;
  /**
   * 要放入 details.mcpResult 的原始 MCP 结果。JSON 未超限时原样保留；
   * 超限时替换成摘要并把完整 JSON 写入临时文件。不需要暴露原始结果的调用方可省略。
   */
  rawMcpResult?: unknown;
}

/** 输出保护后的统一返回模型：模型可见 content、可选截断信息、可选原始结果或摘要。 */
export interface GuardedMcpOutput {
  /** 最终返回给模型的文本和图片 content blocks。 */
  content: ContentBlock[];
  /** 仅在文本发生截断时存在的截断详情。 */
  outputGuard?: McpOutputGuardDetails;
  /** 未超限时为原始 MCP 结果，超限时为 McpResultSummary。 */
  mcpResult?: unknown;
}

/** 合并配置、默认值和环境变量开关，得到实际保护阈值。 */
export function resolveMcpOutputGuardOptions(settings?: McpSettings): Pick<McpOutputGuardOptions, "enabled" | "maxBytes" | "maxLines" | "detailsMaxBytes"> {
  const configured = settings?.outputGuard;
  const tuning = typeof configured === "object" && configured !== null ? configured : undefined;
  return {
    enabled: envKillSwitch("MCP_OUTPUT_GUARD") ?? configured !== false,
    maxBytes: positiveInt(tuning?.maxBytes) ?? DEFAULT_MCP_OUTPUT_MAX_BYTES,
    maxLines: positiveInt(tuning?.maxLines) ?? DEFAULT_MCP_OUTPUT_MAX_LINES,
    detailsMaxBytes: positiveInt(tuning?.detailsMaxBytes) ?? DEFAULT_MCP_DETAILS_MAX_BYTES,
  };
}

/** 供 tool details 展开使用；只返回实际存在的 mcpResult/outputGuard 字段。 */
export function guardedMcpDetails(guarded: GuardedMcpOutput): Record<string, unknown> {
  return {
    ...(guarded.mcpResult !== undefined ? { mcpResult: guarded.mcpResult } : {}),
    ...(guarded.outputGuard ? { outputGuard: guarded.outputGuard } : {}),
  };
}

/**
 * 限制模型可见的 MCP 输出。文本同时受 maxBytes 和 maxLines 约束，超限时保留头部预览并落盘完整文本。
 * 图片块不计入文本上下文预算，原样透传；details.mcpResult 则使用独立的 detailsMaxBytes 限制。
 */
export async function guardMcpOutput(
  content: ContentBlock[],
  options: McpOutputGuardOptions = {},
): Promise<GuardedMcpOutput> {
  const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
  const detailsMaxBytes = options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES;
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? "";

  // 先规范化内容和空文本，再统一拼接 prefix/suffix，保证错误前缀等附加文本也被计入预算。
  const normalizedContent = withEmptyTextFallback(
    content.length > 0
      ? sanitizeContent(content)
      : [{ type: "text" as const, text: options.emptyTextFallback ?? "(empty result)" }],
    options.emptyTextFallback,
  );

  if (options.enabled === false) {
    return {
      content: addAffixes(normalizedContent, prefix, suffix),
      mcpResult: options.rawMcpResult,
    };
  }

  const imageBlocks = normalizedContent.filter((block) => block.type === "image");
  const textOutput = normalizedContent
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  const composedOutput = `${prefix}${textOutput}${suffix}`;
  const stats = textStats(composedOutput);

  let guardedContent: ContentBlock[] = addAffixes(normalizedContent, prefix, suffix);
  let outputGuard: McpOutputGuardDetails | undefined;

  if (stats.bytes > maxBytes || stats.lines > maxLines) {
    // 完整文本写入权限为 0600 的临时文件；返回内容只保留预算内头部和定位提示。
    const { path: fullOutputPath, error: writeError } = await saveArtifact("output", composedOutput);
    const notice = formatTruncationNotice(stats, fullOutputPath, writeError);
    const previewBudget = reserveBudget(maxBytes, maxLines, notice);
    const preview = truncateHead(composedOutput, previewBudget.maxBytes, previewBudget.maxLines);
    const finalText = `${preview.content}\n\n${notice}`;
    const finalStats = textStats(finalText);

    guardedContent = [{ type: "text" as const, text: finalText }, ...imageBlocks];
    outputGuard = {
      truncated: true,
      originalBytes: stats.bytes,
      returnedBytes: finalStats.bytes,
      originalLines: stats.lines,
      returnedLines: finalStats.lines,
      ...(imageBlocks.length > 0 ? { imageBlocksPassedThrough: imageBlocks.length } : {}),
      fullOutputPath,
      writeError,
    };
  }

  // 文本 content 与结构化 details 分开限流，防止大结果从 details 绕过保护。
  const mcpResult = options.rawMcpResult === undefined
    ? undefined
    : await boundMcpResult(options.rawMcpResult, detailsMaxBytes);

  return { content: guardedContent, outputGuard, mcpResult };
}

function sanitizeContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    const mimeType = typeof block.mimeType === "string" && block.mimeType.trim()
      ? block.mimeType.trim().slice(0, 100)
      : "image/png";
    return { ...block, mimeType };
  });
}

function withEmptyTextFallback(content: ContentBlock[], fallback: string | undefined): ContentBlock[] {
  if (!fallback) return content;
  const textOutput = content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  if (textOutput) return content;
  return [{ type: "text", text: fallback }, ...content.filter((block) => block.type === "image")];
}

function addAffixes(content: ContentBlock[], prefix: string, suffix: string): ContentBlock[] {
  if (!prefix && !suffix) return content;
  const next: ContentBlock[] = [...content];

  if (prefix) {
    const index = next.findIndex((block) => block.type === "text");
    const block = next[index];
    if (index >= 0 && block.type === "text") {
      next[index] = { ...block, text: `${prefix}${block.text}` };
    } else {
      next.unshift({ type: "text", text: prefix });
    }
  }

  if (suffix) {
    let index = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].type === "text") {
        index = i;
        break;
      }
    }
    const block = next[index];
    if (index >= 0 && block.type === "text") {
      next[index] = { ...block, text: `${block.text}${suffix}` };
    } else {
      next.push({ type: "text", text: suffix });
    }
  }

  return next;
}

function reserveBudget(maxBytes: number, maxLines: number, notice: string): { maxBytes: number; maxLines: number } {
  const noticeStats = textStats(`\n\n${notice}`);
  return {
    maxBytes: Math.max(0, maxBytes - noticeStats.bytes),
    maxLines: Math.max(0, maxLines - noticeStats.lines),
  };
}

function truncateHead(text: string, maxBytes: number, maxLines: number): { content: string; bytes: number; lines: number } {
  const lines = text.split("\n");
  const output: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    if (output.length >= maxLines) break;
    const separatorBytes = output.length > 0 ? 1 : 0;
    const lineBytes = byteLength(line);
    if (bytes + separatorBytes + lineBytes > maxBytes) {
      const remaining = maxBytes - bytes - separatorBytes;
      if (remaining > 0) {
        output.push(truncateStringToBytes(line, remaining));
      }
      break;
    }
    output.push(line);
    bytes += separatorBytes + lineBytes;
  }

  const content = output.join("\n");
  const stats = textStats(content);
  return { content, bytes: stats.bytes, lines: stats.lines };
}

function truncateStringToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function formatTruncationNotice(
  stats: { bytes: number; lines: number },
  fullOutputPath: string | undefined,
  writeError: string | undefined,
): string {
  const base = `[MCP text output truncated: original ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}.`;
  if (fullOutputPath) {
    return `${base} Full text saved to: ${fullOutputPath} — use read with offset/limit or grep to inspect.]`;
  }
  return `${base} Full output could not be saved: ${writeError ?? "unknown error"}]`;
}

/** details.mcpResult 未超限时原样保留；超限时生成有界摘要并落盘完整 JSON。 */
async function boundMcpResult(result: unknown, detailsMaxBytes: number): Promise<unknown> {
  const raw = safeStringify(result);
  const rawBytes = byteLength(raw);
  if (rawBytes <= detailsMaxBytes) return result;
  return summarizeMcpResult(result, raw, rawBytes);
}

/** 摘要只保留类型、数量、键预览和估算大小，不复制可能很大的字段值。 */
async function summarizeMcpResult(result: unknown, raw: string, rawBytes: number): Promise<McpResultSummary> {
  const { path: fullResultPath, error: resultWriteError } = await saveArtifact("mcp-result", raw);

  const record = asRecord(result);
  const content = Array.isArray(record?.content) ? record.content : [];
  const summary: McpResultSummary = {
    omitted: true,
    reason: "Raw MCP result exceeded the details size limit and was replaced with this summary to keep session context bounded.",
    isError: record?.isError === true,
    contentBlocks: content.length,
    contentSummary: summarizeContent(content),
    rawResultBytes: rawBytes,
    fullResultPath,
    resultWriteError,
  };

  if (record && "structuredContent" in record) {
    summary.structuredContent = summarizeValue(record.structuredContent);
  }
  if (record && "_meta" in record) {
    summary.meta = summarizeValue(record._meta);
  }
  if (record) {
    const standard = new Set(["content", "isError", "structuredContent", "_meta"]);
    const extraFields = Object.keys(record)
      .filter((key) => !standard.has(key))
      .slice(0, KEY_PREVIEW_LIMIT)
      .map((key) => ({ key: truncateKey(key), type: typeof record[key], estimatedBytes: estimateValueBytes(record[key]), omitted: true }));
    if (extraFields.length > 0) summary.extraFields = extraFields;
  }

  return summary;
}

function summarizeContent(content: unknown[]): Array<Record<string, unknown>> {
  const summaries: Array<Record<string, unknown>> = content.slice(0, CONTENT_SUMMARY_LIMIT).map((block) => {
    const record = asRecord(block);
    if (!record) return { type: typeof block, omitted: true };
    if (record.type === "text") {
      const text = typeof record.text === "string" ? record.text : "";
      return { type: "text", bytes: byteLength(text), lines: textStats(text).lines, textOmitted: true };
    }
    if (record.type === "image") {
      const data = typeof record.data === "string" ? record.data : "";
      return { type: "image", mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined, dataBytes: byteLength(data), dataOmitted: true };
    }
    return { type: typeof record.type === "string" ? record.type : "unknown", estimatedBytes: estimateValueBytes(record), omitted: true };
  });
  if (content.length > CONTENT_SUMMARY_LIMIT) {
    summaries.push({ type: "omitted", count: content.length - CONTENT_SUMMARY_LIMIT });
  }
  return summaries;
}

function summarizeValue(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    return { type: value === null ? "null" : typeof value, estimatedBytes: estimateValueBytes(value), omitted: true };
  }
  const keys = Object.keys(record);
  return {
    type: Array.isArray(value) ? "array" : "object",
    estimatedBytes: estimateValueBytes(value),
    keyCount: keys.length,
    keysPreview: keys.slice(0, KEY_PREVIEW_LIMIT).map(truncateKey),
    omitted: true,
  };
}

function estimateValueBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return byteLength(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return byteLength(String(value));
  const record = asRecord(value);
  if (!record || depth >= 2) return 0;
  const values = Array.isArray(value) ? value.slice(0, KEY_PREVIEW_LIMIT) : Object.values(record).slice(0, KEY_PREVIEW_LIMIT);
  return values.reduce((total, item) => total + estimateValueBytes(item, depth + 1), 0);
}

function truncateKey(key: string): string {
  return key.length <= KEY_MAX_CHARS ? key : `${key.slice(0, KEY_MAX_CHARS - 1)}…`;
}

/** 每份完整输出写入独立临时目录，文件权限仅当前用户可读写。 */
async function saveArtifact(kind: string, text: string): Promise<{ path?: string; error?: string }> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-output-"));
    const path = join(dir, `${kind}-${randomBytes(4).toString("hex")}.txt`);
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function asRecord(value: unknown): Recordish | undefined {
  return typeof value === "object" && value !== null ? value as Recordish : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function textStats(text: string): { bytes: number; lines: number } {
  return { bytes: byteLength(text), lines: text.length === 0 ? 0 : text.split("\n").length };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function envKillSwitch(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
