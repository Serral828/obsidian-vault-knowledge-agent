import { App, requestUrl } from "obsidian";
import { ModelConnection } from "./types";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export class ModelClient {
  constructor(private readonly app: App) {}

  secretId(connectionId: string): string { return `vault-knowledge-agent-${connectionId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"); }

  getApiKey(connection: ModelConnection): string { return this.app.secretStorage.getSecret(this.secretId(connection.id)) ?? ""; }

  setApiKey(connection: ModelConnection, apiKey: string): void { this.app.secretStorage.setSecret(this.secretId(connection.id), apiKey); }

  async discoverModels(connection: ModelConnection): Promise<string[]> {
    const response = await requestUrl({ url: this.url(connection, "/models"), method: "GET", headers: this.headers(connection) });
    const data = Array.isArray(response.json?.data) ? response.json.data : [];
    const ids: string[] = [];
    for (const item of data as Array<{ id?: unknown }>) if (typeof item.id === "string" && item.id) ids.push(item.id);
    return [...new Set(ids)].sort();
  }

  async embed(connection: ModelConnection, texts: string[]): Promise<number[][]> {
    if (!connection.embeddingModel) throw new Error("尚未配置嵌入模型");
    const response = await requestUrl({
      url: this.url(connection, "/embeddings"),
      method: "POST",
      contentType: "application/json",
      headers: this.headers(connection),
      body: JSON.stringify({ model: connection.embeddingModel, input: texts })
    });
    const data = Array.isArray(response.json?.data) ? response.json.data : [];
    return data.sort((a: { index: number }, b: { index: number }) => a.index - b.index).map((item: { embedding: number[] }) => item.embedding);
  }

  async chat(connection: ModelConnection, messages: OpenAIMessage[], tools: ToolDefinition[]): Promise<OpenAIMessage> {
    if (!connection.chatModel) throw new Error("请先在齿轮设置中选择聊天模型");
    const response = await requestUrl({
      url: this.url(connection, "/chat/completions"),
      method: "POST",
      contentType: "application/json",
      headers: this.headers(connection),
      body: JSON.stringify({ model: connection.chatModel, messages, tools, tool_choice: "auto", temperature: 0.2 })
    });
    const message = response.json?.choices?.[0]?.message as OpenAIMessage | undefined;
    if (!message) throw new Error(response.text || "模型服务未返回有效消息");
    return message;
  }

  private url(connection: ModelConnection, path: string): string {
    const base = connection.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) throw new Error("Base URL 必须以 http:// 或 https:// 开头");
    return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`;
  }

  private headers(connection: ModelConnection): Record<string, string> {
    const key = this.getApiKey(connection);
    return key ? { Authorization: `Bearer ${key}` } : {};
  }
}
