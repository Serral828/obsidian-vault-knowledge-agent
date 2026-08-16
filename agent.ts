import { App, normalizePath, TFile } from "obsidian";
import { VaultIndexer } from "./indexer";
import { ModelClient, OpenAIMessage, ToolCall, ToolDefinition } from "./model";
import { AgentSettings, ChangeProposal, ModelConnection, ProposedChange, SearchHit, TaskSession } from "./types";

export interface PreparedContext {
  question: string;
  evidence: SearchHit[];
  queryEmbedding?: number[];
}

export interface AgentResult {
  content: string;
  evidence: string[];
  retrievalTrace: string[];
  proposal?: ChangeProposal;
}

export class AgentEngine {
  constructor(
    private readonly app: App,
    private readonly indexer: VaultIndexer,
    private readonly model: ModelClient,
    private readonly settings: () => AgentSettings
  ) {}

  async prepare(question: string, connection: ModelConnection): Promise<PreparedContext> {
    const expanded = this.expandCommand(question);
    let queryEmbedding: number[] | undefined;
    if (connection.embeddingModel) {
      try { [queryEmbedding] = await this.model.embed(connection, [expanded]); } catch { queryEmbedding = undefined; }
    }
    return { question: expanded, evidence: this.indexer.search(expanded, 8, queryEmbedding), queryEmbedding };
  }

  async run(session: TaskSession, connection: ModelConnection, prepared: PreparedContext): Promise<AgentResult> {
    const evidence = new Set(prepared.evidence.map((hit) => hit.path));
    const trace = new Set(prepared.evidence.map((hit) => hit.path));
    let proposal: ChangeProposal | undefined;
    const storedHistory = session.messages[session.messages.length - 1]?.role === "user" ? session.messages.slice(0, -1) : session.messages;
    const messages: OpenAIMessage[] = [
      { role: "system", content: this.systemPrompt() },
      { role: "system", content: `本轮本地预检索结果：\n${JSON.stringify(prepared.evidence, null, 2)}` },
      ...storedHistory.slice(-18).map((message): OpenAIMessage => ({ role: message.role, content: message.content })),
      { role: "user", content: prepared.question }
    ];
    const tools = this.tools();

    for (let turn = 0; turn < 8; turn++) {
      const assistant = await this.model.chat(connection, messages, tools);
      messages.push(assistant);
      if (!assistant.tool_calls?.length) {
        return {
          content: assistant.content?.trim() || (proposal ? "已生成变更提案，请在界面中审阅。" : "模型没有返回文本。"),
          evidence: [...evidence],
          retrievalTrace: [...trace],
          proposal
        };
      }

      for (const call of assistant.tool_calls) {
        const result = await this.executeTool(call, connection, evidence, trace);
        if (result.proposal) proposal = result.proposal;
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.output) });
      }
    }
    return { content: "Agent 已达到本轮最大工具调用次数，请缩小问题范围后继续。", evidence: [...evidence], retrievalTrace: [...trace], proposal };
  }

  private async executeTool(
    call: ToolCall,
    connection: ModelConnection,
    evidence: Set<string>,
    trace: Set<string>
  ): Promise<{ output: unknown; proposal?: ChangeProposal }> {
    let args: Record<string, unknown>;
    try { args = JSON.parse(call.function.arguments || "{}"); } catch { return { output: { error: "工具参数不是有效 JSON" } }; }

    switch (call.function.name) {
      case "search_vault": {
        const query = String(args.query ?? "");
        let vector: number[] | undefined;
        if (connection.embeddingModel && query) {
          try { [vector] = await this.model.embed(connection, [query]); } catch { vector = undefined; }
        }
        const hits = this.indexer.search(query, Number(args.limit ?? 8), vector);
        for (const hit of hits) trace.add(hit.path);
        return { output: hits };
      }
      case "read_note": {
        const path = this.safePath(String(args.path ?? ""));
        const doc = this.indexer.getDocument(path);
        if (!doc) return { output: { error: "该路径不在 Knowledge Index 中", path } };
        evidence.add(path);
        trace.add(path);
        return { output: doc };
      }
      case "get_backlinks": {
        const path = this.safePath(String(args.path ?? ""));
        const backlinks = this.indexer.getBacklinks(path);
        backlinks.forEach((item) => trace.add(item));
        return { output: { path, backlinks } };
      }
      case "list_tags": return { output: this.indexer.listTags().slice(0, 200) };
      case "list_indexed_documents": return { output: this.indexer.getAllDocuments().slice(0, 1200).map((doc) => ({ path: doc.path, extension: doc.extension, title: doc.title, tags: doc.tags, links: doc.links, headings: doc.headings, imageRefs: doc.imageRefs })) };
      case "audit_vault": return { output: this.indexer.audit() };
      case "inspect_properties": {
        const path = this.safePath(String(args.path ?? ""));
        const doc = this.indexer.getDocument(path);
        if (doc) trace.add(path);
        return { output: doc ? { path, properties: doc.properties, tags: doc.tags, headings: doc.headings } : { error: "未找到 Indexed Document" } };
      }
      case "list_files": {
        if (!this.settings().filesystemMode) return { output: { error: "Vault Filesystem Mode 未开启" } };
        const prefix = this.safePath(String(args.prefix ?? ""), true);
        const files = this.app.vault.getFiles().map((file) => file.path).filter((path) => !prefix || path.startsWith(prefix)).slice(0, 1000);
        return { output: files };
      }
      case "read_file": {
        if (!this.settings().filesystemMode) return { output: { error: "Vault Filesystem Mode 未开启" } };
        const path = this.safePath(String(args.path ?? ""));
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return { output: { error: "文件不存在", path } };
        if (!this.isPlaintext(file)) return { output: { error: "该文件不是可读取的文本格式", path } };
        trace.add(path);
        evidence.add(path);
        return { output: { path, content: (await this.app.vault.cachedRead(file)).slice(0, 50000) } };
      }
      case "propose_changes": {
        const built = this.buildProposal(args);
        return { output: { acceptedForReview: true, proposalId: built.id, changes: built.changes.length }, proposal: built };
      }
      default: return { output: { error: `未知工具：${call.function.name}` } };
    }
  }

  private tools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      this.tool("search_vault", "搜索整个当前 Vault 的本地 Knowledge Index。", {
        type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"]
      }),
      this.tool("read_note", "读取一个 Indexed Document 的完整正文与元数据。", {
        type: "object", properties: { path: { type: "string" } }, required: ["path"]
      }),
      this.tool("get_backlinks", "列出链接到指定笔记的其他笔记。", {
        type: "object", properties: { path: { type: "string" } }, required: ["path"]
      }),
      this.tool("list_tags", "列出当前 Vault 的标签及使用次数。", { type: "object", properties: {} }),
      this.tool("list_indexed_documents", "列出 Knowledge Index 中的文档路径和知识关系，用于整库盘点。", { type: "object", properties: {} }),
      this.tool("audit_vault", "运行确定性的知识库体检，返回孤立笔记、重复标题、空文档和标签统计。", { type: "object", properties: {} }),
      this.tool("inspect_properties", "读取指定笔记的属性、标签和标题结构。", {
        type: "object", properties: { path: { type: "string" } }, required: ["path"]
      }),
      this.tool("propose_changes", "创建需要用户逐项确认的 Change Proposal。不得声称变更已经执行。", {
        type: "object",
        properties: {
          title: { type: "string" }, summary: { type: "string" },
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["create", "modify", "move", "delete"] },
                path: { type: "string" }, newPath: { type: "string" }, content: { type: "string" },
                reason: { type: "string" }, evidence: { type: "array", items: { type: "string" } }
              },
              required: ["kind", "path", "reason", "evidence"]
            }
          }
        },
        required: ["title", "summary", "changes"]
      })
    ];
    if (this.settings().filesystemMode) {
      tools.push(
        this.tool("list_files", "列出当前 Vault Boundary 内的文件。", { type: "object", properties: { prefix: { type: "string" } } }),
        this.tool("read_file", "读取当前 Vault Boundary 内的纯文本文件。", { type: "object", properties: { path: { type: "string" } }, required: ["path"] })
      );
    }
    return tools;
  }

  private systemPrompt(): string {
    const supplement = this.settings().allowModelKnowledge
      ? "允许使用模型自身知识，但必须放在“模型补充”小节，不能冒充 Vault Evidence。"
      : "严禁使用模型自身知识补齐缺失事实；Vault 证据不足时必须明确说明未找到依据。";
    return [
      "你是 Vault Knowledge Agent，一个专精 Obsidian 知识管理的助手。",
      "知识边界严格限定当前 Vault。先搜索，再阅读证据，最后回答。",
      "关键结论必须使用 Obsidian wikilink 引用具体来源，例如 [[folder/note#heading]]。不要引用未读取的笔记。",
      "回答使用简洁的 Obsidian Markdown：先给结论，不使用一级标题，不滥用标题、分隔线、粗体和嵌套列表；短问题直接用自然段回答。",
      "不要联网，不要访问 Vault 外路径，不要执行 Shell。",
      "如需新增、编辑、移动或删除文件，只能调用 propose_changes；等待用户确认，不得声称已经修改。",
      "删除的含义是用户确认后由插件送入操作系统回收站。",
      supplement
    ].join("\n");
  }

  private buildProposal(args: Record<string, unknown>): ChangeProposal {
    const rawChanges = Array.isArray(args.changes) ? args.changes : [];
    const changes: ProposedChange[] = rawChanges.map((raw, index) => {
      const item = raw as Record<string, unknown>;
      const kind = String(item.kind ?? "") as ProposedChange["kind"];
      if (!["create", "modify", "move", "delete"].includes(kind)) throw new Error(`无效变更类型：${kind}`);
      const path = this.safePath(String(item.path ?? ""));
      const newPath = item.newPath ? this.safePath(String(item.newPath)) : undefined;
      return {
        id: `${Date.now()}-${index}`,
        kind,
        path,
        newPath,
        content: typeof item.content === "string" ? item.content : undefined,
        reason: String(item.reason ?? ""),
        evidence: Array.isArray(item.evidence) ? item.evidence.map(String).map((value) => this.safePath(value)) : [],
        selected: true
      };
    });
    return {
      id: crypto.randomUUID(),
      title: String(args.title ?? "变更提案"),
      summary: String(args.summary ?? ""),
      changes,
      createdAt: Date.now(),
      status: "pending"
    };
  }

  private safePath(input: string, allowEmpty = false): string {
    const value = normalizePath(input.replace(/\\/g, "/").trim());
    if (allowEmpty && !value) return "";
    if (!value || value === "." || value.startsWith("../") || value.includes("/../") || value.startsWith("/") || /^[a-z]:/i.test(value)) throw new Error(`路径超出 Vault Boundary：${input}`);
    if (value === ".obsidian" || value.startsWith(".obsidian/")) throw new Error("不允许操作 .obsidian 配置目录");
    return value;
  }

  private isPlaintext(file: TFile): boolean {
    return ["md", "txt", "canvas", "base", "json", "yaml", "yml", "csv", "tsv", "py", "js", "ts", "css", "html"].includes(file.extension.toLowerCase());
  }

  private tool(name: string, description: string, parameters: Record<string, unknown>): ToolDefinition {
    return { type: "function", function: { name, description, parameters } };
  }

  private expandCommand(question: string): string {
    const trimmed = question.trim();
    if (trimmed === "/audit") return "对整个 Vault 做知识库体检：查找重复内容、孤立笔记、缺失链接、标签或属性不一致，并给出有证据的报告；需要修改时生成 Change Proposal。";
    if (trimmed.startsWith("/organize")) return `提出整库知识整理方案并为需要的修改生成 Change Proposal。用户补充：${trimmed.slice(9).trim()}`;
    if (trimmed.startsWith("/synthesize")) return `跨多篇笔记综合形成有引用的综述；如用户要求写入，生成 Change Proposal。主题：${trimmed.slice(11).trim()}`;
    return trimmed;
  }
}
