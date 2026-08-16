import { ItemView, MarkdownRenderer, Modal, Notice, Setting, setIcon, WorkspaceLeaf } from "obsidian";
import type VaultKnowledgeAgentPlugin from "./main";
import { ChangeProposal, ModelConnection, SharedContextPreview, TaskSession } from "./types";

export const VIEW_TYPE_KNOWLEDGE_AGENT = "vault-knowledge-agent-view";

export class KnowledgeAgentView extends ItemView {
  private sessionSelect!: HTMLSelectElement;
  private chatEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private sendButton!: HTMLButtonElement;
  private sessions: TaskSession[] = [];
  private current!: TaskSession;
  private running = false;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: VaultKnowledgeAgentPlugin) { super(leaf); }

  getViewType(): string { return VIEW_TYPE_KNOWLEDGE_AGENT; }
  getDisplayText(): string { return "Vault Knowledge Agent"; }
  getIcon(): string { return "brain-circuit"; }

  async onOpen(): Promise<void> {
    await this.loadSessions();
    this.render();
  }

  updateIndexStatus(): void {
    if (!this.statusEl) return;
    const status = this.plugin.indexer.getStatus();
    this.statusEl.setText(status.state === "ready" ? `已索引 ${status.indexed} 项` : status.state === "building" ? `索引 ${status.indexed}/${status.total}` : status.state === "error" ? "索引错误" : "尚未建立索引");
  }

  private async loadSessions(): Promise<void> {
    this.sessions = await this.plugin.getSessions();
    if (!this.sessions.length) this.sessions = [await this.plugin.createSession()];
    this.current = this.sessions[0];
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("vka-view");

    const header = root.createDiv({ cls: "vka-header" });
    this.sessionSelect = header.createEl("select", { cls: "vka-session-select" });
    this.refreshSessionSelect();
    this.sessionSelect.addEventListener("change", () => {
      const selected = this.sessions.find((session) => session.id === this.sessionSelect.value);
      if (selected) { this.current = selected; this.renderMessages(); }
    });
    const newButton = this.iconButton(header, "plus", "新建会话");
    newButton.addEventListener("click", () => void this.newSession());
    const sessionButton = this.iconButton(header, "more-horizontal", "会话管理");
    sessionButton.addEventListener("click", () => new SessionActionsModal(this.plugin, this.current, async (deleted) => {
      if (deleted) await this.loadSessions();
      else {
        const replacement = this.sessions.find((session) => session.id === this.current.id);
        if (replacement) replacement.title = this.current.title;
      }
      this.refreshSessionSelect();
      this.renderMessages();
    }).open());
    const gearButton = this.iconButton(header, "settings", "设置");
    gearButton.addEventListener("click", () => new AgentSettingsModal(this.plugin).open());

    this.chatEl = root.createDiv({ cls: "vka-chat" });
    this.renderMessages();

    const composer = root.createDiv({ cls: "vka-composer" });
    this.inputEl = composer.createEl("textarea", { cls: "vka-input", attr: { placeholder: "询问整个 Vault…" } });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void this.send(); }
    });
    const footer = composer.createDiv({ cls: "vka-composer-footer" });
    this.statusEl = footer.createSpan({ cls: "vka-status" });
    this.updateIndexStatus();
    this.sendButton = footer.createEl("button", { text: "发送", cls: "mod-cta" });
    this.sendButton.addEventListener("click", () => void this.send());
  }

  private renderMessages(): void {
    if (!this.chatEl) return;
    this.chatEl.empty();
    if (!this.current.messages.length) {
      const empty = this.chatEl.createDiv({ cls: "vka-empty" });
      empty.createDiv({ cls: "vka-empty-icon", text: "✦" });
      empty.createEl("h3", { text: "询问你的整个 Vault" });
      empty.createDiv({ text: "回答将引用具体笔记；需要修改时会先生成变更提案。" });
      return;
    }
    for (const message of this.current.messages) {
      const row = this.chatEl.createDiv({ cls: `vka-message vka-message-${message.role}` });
      row.createDiv({ cls: "vka-role", text: message.role === "user" ? "你" : "知识助手" });
      const bubble = row.createDiv({ cls: "vka-bubble" });
      if (message.role === "assistant") {
        const sourcePath = this.plugin.app.workspace.getActiveFile()?.path ?? "";
        void MarkdownRenderer.render(this.plugin.app, message.content, bubble, sourcePath, this);
        bubble.addEventListener("click", (event) => this.openRenderedVaultLink(event, sourcePath));
      }
      else bubble.setText(message.content);
      if (message.evidence?.length) {
        const evidence = row.createDiv({ cls: "vka-evidence" });
        evidence.createSpan({ cls: "vka-evidence-label", text: `来源 · ${message.evidence.length}` });
        for (const path of message.evidence.slice(0, 6)) {
          const link = evidence.createEl("button", { text: path, cls: "vka-evidence-link" });
          link.addEventListener("click", () => void this.plugin.app.workspace.openLinkText(path, "", false));
        }
      }
    }
    if (this.current.proposal?.status === "pending") {
      const card = this.chatEl.createDiv({ cls: "vka-proposal-card" });
      card.createEl("strong", { text: this.current.proposal.title });
      card.createDiv({ text: `${this.current.proposal.changes.length} 项待确认变更` });
      const review = card.createEl("button", { text: "审阅 Diff", cls: "mod-cta" });
      review.addEventListener("click", () => new ChangeProposalModal(this.plugin, this.current, () => this.renderMessages()).open());
    }
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }

  private openRenderedVaultLink(event: MouseEvent, sourcePath: string): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;

    const dataHref = anchor.dataset.href?.trim();
    const rawHref = anchor.getAttribute("href")?.trim() ?? "";
    const isInternal = anchor.hasClass("internal-link") || Boolean(dataHref);
    if (!isInternal) return;

    const linkText = dataHref || this.decodeInternalHref(rawHref);
    if (!linkText) return;
    event.preventDefault();
    event.stopPropagation();
    void this.plugin.app.workspace.openLinkText(linkText, sourcePath, event.ctrlKey || event.metaKey);
  }

  private decodeInternalHref(href: string): string {
    if (!href) return "";
    try { return decodeURIComponent(href.replace(/^app:\/\/obsidian\.md\//, "")); }
    catch { return href; }
  }

  private async send(): Promise<void> {
    const question = this.inputEl.value.trim();
    if (!question || this.running) return;
    const connection = this.plugin.getActiveConnection();
    if (!connection?.chatModel) { new Notice("请先点击齿轮，配置模型连接并选择聊天模型。"); return; }
    if (this.plugin.indexer.getStatus().state !== "ready") { new Notice("请先在齿轮设置中建立 Knowledge Index。"); return; }

    this.running = true;
    this.sendButton.disabled = true;
    this.inputEl.value = "";
    const userMessage = { id: crypto.randomUUID(), role: "user" as const, content: question, createdAt: Date.now() };
    this.current.messages.push(userMessage);
    this.current.updatedAt = Date.now();
    await this.plugin.saveSession(this.current);
    this.renderMessages();
    this.statusEl.setText("正在检索 Vault…");

    try {
      const prepared = await this.plugin.engine.prepare(question, connection);
      if (connection.kind === "cloud" && this.plugin.settings.previewCloudContext) {
        const preview: SharedContextPreview = { question: prepared.question, history: this.current.messages.slice(-12), evidence: prepared.evidence, connectionName: connection.name, model: connection.chatModel };
        const approved = await new SharedContextModal(this.plugin, preview).confirm();
        if (!approved) throw new Error("已取消发送到云端模型");
      }
      this.statusEl.setText("Agent 正在研究…");
      const result = await this.plugin.engine.run(this.current, connection, prepared);
      this.current.messages.push({ id: crypto.randomUUID(), role: "assistant", content: result.content, createdAt: Date.now(), evidence: result.evidence });
      this.current.retrievalTrace = [...new Set([...this.current.retrievalTrace, ...result.retrievalTrace])];
      if (result.proposal) this.current.proposal = result.proposal;
      if (this.current.messages.length === 2) this.current.title = question.slice(0, 32) || "新会话";
      this.current.updatedAt = Date.now();
      await this.plugin.saveSession(this.current);
      this.refreshSessionSelect();
      this.renderMessages();
      this.statusEl.setText("完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "已取消发送到云端模型") {
        this.current.messages.push({ id: crypto.randomUUID(), role: "assistant", content: `运行失败：${message}`, createdAt: Date.now() });
        await this.plugin.saveSession(this.current);
        this.renderMessages();
      }
      this.statusEl.setText(message);
    } finally {
      this.running = false;
      this.sendButton.disabled = false;
    }
  }

  private async newSession(): Promise<void> {
    const session = await this.plugin.createSession();
    this.sessions.unshift(session);
    this.current = session;
    this.refreshSessionSelect();
    this.renderMessages();
  }

  private refreshSessionSelect(): void {
    if (!this.sessionSelect) return;
    this.sessionSelect.empty();
    for (const session of this.sessions.sort((a, b) => b.updatedAt - a.updatedAt)) this.sessionSelect.createEl("option", { value: session.id, text: session.title });
    this.sessionSelect.value = this.current?.id ?? "";
  }

  private iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "vka-icon-button", attr: { "aria-label": label } });
    setIcon(button, icon);
    return button;
  }
}

class AgentSettingsModal extends Modal {
  constructor(private readonly plugin: VaultKnowledgeAgentPlugin) { super(plugin.app); }

  onOpen(): void { this.render(); }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vka-settings-modal");
    contentEl.createEl("h2", { text: "Vault Knowledge Agent 设置" });

    const status = this.plugin.indexer.getStatus();
    new Setting(contentEl)
      .setName("Knowledge Index")
      .setDesc(status.state === "ready" ? `已索引 ${status.indexed} 项` : status.message || "尚未建立索引")
      .addButton((button) => button.setButtonText(status.state === "ready" ? "完全重建" : "建立索引").setCta().onClick(async () => {
        button.setDisabled(true).setButtonText("正在建立…");
        try { await this.plugin.rebuildIndex(); new Notice("Knowledge Index 已建立。"); } catch (error) { new Notice(`索引失败：${error instanceof Error ? error.message : String(error)}`); }
        this.render();
      }));

    contentEl.createEl("h3", { text: "模型连接" });
    if (!this.plugin.settings.connections.length) contentEl.createEl("p", { text: "尚未配置模型连接。可以连接 Ollama、LM Studio、vLLM 或云端 OpenAI 兼容 API。" });
    for (const connection of this.plugin.settings.connections) this.renderConnection(contentEl, connection);
    new Setting(contentEl).addButton((button) => button.setButtonText("添加模型连接").setCta().onClick(() => new ConnectionModal(this.plugin, undefined, () => this.render()).open()));

    contentEl.createEl("h3", { text: "权限与回答" });
    new Setting(contentEl).setName("Vault Filesystem Mode").setDesc("允许 Agent 读取当前 Vault 中未进入索引的文本文件；仍不能访问 Vault 外部或执行 Shell。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.filesystemMode).onChange(async (value) => { this.plugin.settings.filesystemMode = value; await this.plugin.saveSettings(); }));
    new Setting(contentEl).setName("允许模型知识补充").setDesc("关闭时，证据不足必须明确说明；开启后模型补充必须单独标记。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.allowModelKnowledge).onChange(async (value) => { this.plugin.settings.allowModelKnowledge = value; await this.plugin.saveSettings(); }));
    new Setting(contentEl).setName("云端发送前预览").addToggle((toggle) => toggle.setValue(this.plugin.settings.previewCloudContext).onChange(async (value) => { this.plugin.settings.previewCloudContext = value; await this.plugin.saveSettings(); }));
  }

  private renderConnection(parent: HTMLElement, connection: ModelConnection): void {
    const box = parent.createDiv({ cls: "vka-connection" });
    const heading = box.createDiv({ cls: "vka-connection-heading" });
    heading.createEl("strong", { text: connection.name });
    heading.createSpan({ text: connection.kind === "local" ? "本地" : "云端", cls: "vka-badge" });
    new Setting(box).setName("聊天模型").addDropdown((dropdown) => {
      dropdown.addOption("", "请选择模型");
      for (const model of [...new Set([...connection.models, ...connection.manualModels])]) dropdown.addOption(model, connection.manualModels.includes(model) ? `${model}（手动）` : model);
      dropdown.setValue(connection.chatModel).onChange(async (value) => { connection.chatModel = value; await this.plugin.saveSettings(); });
    });
    new Setting(box).setName("嵌入模型（可选）").addDropdown((dropdown) => {
      dropdown.addOption("", connection.kind === "cloud" ? "云端连接禁止批量嵌入" : "不使用向量检索");
      if (connection.kind === "local") for (const model of [...new Set([...connection.models, ...connection.manualModels])]) dropdown.addOption(model, model);
      dropdown.setValue(connection.kind === "local" ? connection.embeddingModel : "").setDisabled(connection.kind === "cloud").onChange(async (value) => { connection.embeddingModel = value; await this.plugin.saveSettings(); });
    });
    const actions = box.createDiv({ cls: "vka-connection-actions" });
    const active = actions.createEl("button", { text: this.plugin.settings.activeConnectionId === connection.id ? "当前连接" : "设为当前" });
    active.disabled = this.plugin.settings.activeConnectionId === connection.id;
    active.addEventListener("click", async () => { this.plugin.settings.activeConnectionId = connection.id; await this.plugin.saveSettings(); this.render(); });
    actions.createEl("button", { text: "刷新模型" }).addEventListener("click", async () => {
      try { connection.models = await this.plugin.modelClient.discoverModels(connection); await this.plugin.saveSettings(); new Notice(`读取到 ${connection.models.length} 个模型。`); this.render(); }
      catch (error) { new Notice(`模型发现失败：${error instanceof Error ? error.message : String(error)}`); }
    });
    actions.createEl("button", { text: "编辑" }).addEventListener("click", () => new ConnectionModal(this.plugin, connection, () => this.render()).open());
    actions.createEl("button", { text: "删除" }).addEventListener("click", async () => { await this.plugin.removeConnection(connection.id); this.render(); });
  }
}

class ConnectionModal extends Modal {
  private draft: ModelConnection;
  private apiKey = "";

  constructor(private readonly plugin: VaultKnowledgeAgentPlugin, connection: ModelConnection | undefined, private readonly done: () => void) {
    super(plugin.app);
    this.draft = connection ? JSON.parse(JSON.stringify(connection)) : { id: crypto.randomUUID(), name: "本地模型", baseUrl: "http://127.0.0.1:11434", kind: "local", models: [], manualModels: [], chatModel: "", embeddingModel: "" };
    if (connection) this.apiKey = plugin.modelClient.getApiKey(connection);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "模型连接" });
    new Setting(contentEl).setName("名称").addText((text) => text.setValue(this.draft.name).onChange((value) => { this.draft.name = value; }));
    new Setting(contentEl).setName("类型").addDropdown((dropdown) => dropdown.addOption("local", "本地").addOption("cloud", "云端").setValue(this.draft.kind).onChange((value) => { this.draft.kind = value as "local" | "cloud"; }));
    new Setting(contentEl).setName("Base URL").setDesc("填写到服务根地址或 /v1，例如 http://127.0.0.1:11434")
      .addText((text) => text.setValue(this.draft.baseUrl).onChange((value) => { this.draft.baseUrl = value.trim(); }));
    new Setting(contentEl).setName("API Key").setDesc("使用 Obsidian SecretStorage，仅保存在本机。")
      .addText((text) => { text.inputEl.type = "password"; text.setValue(this.apiKey).onChange((value) => { this.apiKey = value; }); });
    new Setting(contentEl).setName("手动模型 ID").setDesc("仅在服务不支持 /v1/models 时使用，逗号分隔。")
      .addTextArea((text) => text.setValue(this.draft.manualModels.join(", ")).onChange((value) => { this.draft.manualModels = value.split(",").map((item) => item.trim()).filter(Boolean); }));
    new Setting(contentEl).addButton((button) => button.setButtonText("保存并读取模型").setCta().onClick(async () => {
      if (!this.draft.name.trim() || !this.draft.baseUrl.trim()) { new Notice("请填写连接名称和 Base URL。"); return; }
      if (this.draft.kind === "cloud") this.draft.embeddingModel = "";
      this.plugin.modelClient.setApiKey(this.draft, this.apiKey);
      try { this.draft.models = await this.plugin.modelClient.discoverModels(this.draft); }
      catch (error) { if (!this.draft.manualModels.length) new Notice(`模型发现失败，可填写手动模型 ID：${error instanceof Error ? error.message : String(error)}`); }
      await this.plugin.upsertConnection(this.draft);
      this.close();
      this.done();
    }));
  }
}

class SessionActionsModal extends Modal {
  private title: string;

  constructor(private readonly plugin: VaultKnowledgeAgentPlugin, private readonly session: TaskSession, private readonly done: (deleted: boolean) => Promise<void>) {
    super(plugin.app);
    this.title = session.title;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "会话管理" });
    new Setting(contentEl).setName("会话名称").addText((text) => text.setValue(this.title).onChange((value) => { this.title = value; }));
    const actions = contentEl.createDiv({ cls: "vka-modal-actions" });
    actions.createEl("button", { text: "删除会话", cls: "mod-warning" }).addEventListener("click", async () => {
      await this.plugin.deleteSession(this.session.id);
      this.close();
      await this.done(true);
    });
    actions.createEl("button", { text: "保存名称", cls: "mod-cta" }).addEventListener("click", async () => {
      this.session.title = this.title.trim() || "未命名会话";
      await this.plugin.saveSession(this.session);
      this.close();
      await this.done(false);
    });
  }
}

class SharedContextModal extends Modal {
  private resolver: ((value: boolean) => void) | null = null;

  constructor(plugin: VaultKnowledgeAgentPlugin, private readonly preview: SharedContextPreview) { super(plugin.app); }

  confirm(): Promise<boolean> { this.open(); return new Promise((resolve) => { this.resolver = resolve; }); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "发送到云端前预览" });
    contentEl.createEl("p", { text: `${this.preview.connectionName} · ${this.preview.model}` });
    contentEl.createEl("h3", { text: "问题" });
    contentEl.createEl("pre", { text: this.preview.question });
    contentEl.createEl("h3", { text: `本地选出的 Vault Evidence（${this.preview.evidence.length}）` });
    for (const hit of this.preview.evidence) {
      const item = contentEl.createDiv({ cls: "vka-context-item" });
      item.createEl("strong", { text: hit.path });
      item.createEl("pre", { text: hit.snippet.slice(0, 700) });
    }
    contentEl.createEl("p", { text: `同时发送最近 ${this.preview.history.length} 条会话消息。Agent 后续工具检索到的证据也会发送给该模型连接。` });
    const actions = contentEl.createDiv({ cls: "vka-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.finish(false));
    actions.createEl("button", { text: "确认发送", cls: "mod-cta" }).addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    const resolver = this.resolver;
    this.resolver = null;
    resolver?.(false);
  }

  private finish(value: boolean): void {
    const resolver = this.resolver;
    this.resolver = null;
    this.close();
    resolver?.(value);
  }
}

class ChangeProposalModal extends Modal {
  constructor(private readonly plugin: VaultKnowledgeAgentPlugin, private readonly session: TaskSession, private readonly done: () => void) { super(plugin.app); }

  onOpen(): void { void this.render(); }

  private async render(): Promise<void> {
    const proposal = this.session.proposal;
    if (!proposal) return;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vka-proposal-modal");
    contentEl.createEl("h2", { text: proposal.title });
    contentEl.createEl("p", { text: proposal.summary });
    for (const change of proposal.changes) {
      const item = contentEl.createDiv({ cls: "vka-change" });
      new Setting(item).setName(`${change.kind.toUpperCase()} · ${change.path}`).setDesc(change.reason)
        .addToggle((toggle) => toggle.setValue(change.selected).onChange((value) => { change.selected = value; }));
      if (change.evidence.length) item.createDiv({ cls: "vka-change-evidence", text: `依据：${change.evidence.join(", ")}` });
      const oldFile = this.plugin.app.vault.getAbstractFileByPath(change.path);
      const before = oldFile && "extension" in oldFile ? await this.plugin.app.vault.cachedRead(oldFile as import("obsidian").TFile) : "（文件不存在）";
      const details = item.createEl("details");
      details.createEl("summary", { text: "查看 Diff" });
      details.createEl("h4", { text: "修改前" });
      details.createEl("pre", { text: before.slice(0, 20000) });
      details.createEl("h4", { text: change.kind === "move" ? `移动到 ${change.newPath ?? ""}` : "修改后" });
      details.createEl("pre", { text: change.kind === "delete" ? "（送入系统回收站）" : (change.content ?? before).slice(0, 20000) });
    }
    const actions = contentEl.createDiv({ cls: "vka-modal-actions" });
    actions.createEl("button", { text: "关闭" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "应用已选变更", cls: "mod-warning" }).addEventListener("click", async () => {
      try {
        await this.plugin.applyProposal(proposal);
        await this.plugin.saveSession(this.session);
        new Notice("已应用选中的变更。");
        this.close();
        this.done();
      } catch (error) { new Notice(`应用失败：${error instanceof Error ? error.message : String(error)}`); }
    });
  }
}
