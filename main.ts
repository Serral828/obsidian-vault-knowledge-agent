import { Plugin, TFile, normalizePath } from "obsidian";
import { AgentEngine } from "./agent";
import { VaultIndexer } from "./indexer";
import { ModelClient } from "./model";
import { LocalDatabase } from "./storage";
import { AgentSettings, ChangeProposal, DEFAULT_SETTINGS, ModelConnection, TaskSession } from "./types";
import { KnowledgeAgentView, VIEW_TYPE_KNOWLEDGE_AGENT } from "./ui";

const LOCAL_SETTINGS_KEY = "vault-knowledge-agent-settings";

export default class VaultKnowledgeAgentPlugin extends Plugin {
  settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  db!: LocalDatabase;
  indexer!: VaultIndexer;
  modelClient!: ModelClient;
  engine!: AgentEngine;
  private updateTimers = new Map<string, number>();

  async onload(): Promise<void> {
    this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), this.app.loadLocalStorage(LOCAL_SETTINGS_KEY) ?? {});
    this.settings.indexedExtensions = this.settings.indexedExtensions?.length ? this.settings.indexedExtensions : [...DEFAULT_SETTINGS.indexedExtensions];
    this.modelClient = new ModelClient(this.app);
    this.db = new LocalDatabase(`vault-knowledge-agent-${this.vaultKey()}`);
    this.indexer = new VaultIndexer(this.app, this.db, () => this.settings.indexedExtensions, () => this.notifyViews());
    await this.indexer.initialize();
    this.engine = new AgentEngine(this.app, this.indexer, this.modelClient, () => this.settings);

    this.registerView(VIEW_TYPE_KNOWLEDGE_AGENT, (leaf) => new KnowledgeAgentView(leaf, this));
    this.addRibbonIcon("brain-circuit", "打开 Vault Knowledge Agent", () => void this.activateView());
    this.addCommand({ id: "open-vault-knowledge-agent", name: "打开 Vault Knowledge Agent", callback: () => void this.activateView() });
    this.addCommand({ id: "rebuild-knowledge-index", name: "重建 Knowledge Index", callback: () => void this.rebuildIndex() });

    this.registerEvent(this.app.vault.on("create", (file) => { if (file instanceof TFile) this.scheduleUpdate(file); }));
    this.registerEvent(this.app.vault.on("modify", (file) => { if (file instanceof TFile) this.scheduleUpdate(file); }));
    this.registerEvent(this.app.vault.on("delete", (file) => void this.indexer.removePath(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.indexer.removePath(oldPath);
      if (file instanceof TFile) this.scheduleUpdate(file);
    }));
  }

  onunload(): void {
    for (const timer of this.updateTimers.values()) window.clearTimeout(timer);
  }

  async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_KNOWLEDGE_AGENT)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_KNOWLEDGE_AGENT, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings(): Promise<void> {
    this.app.saveLocalStorage(LOCAL_SETTINGS_KEY, this.settings);
  }

  getActiveConnection(): ModelConnection | undefined {
    return this.settings.connections.find((connection) => connection.id === this.settings.activeConnectionId) ?? this.settings.connections[0];
  }

  async upsertConnection(connection: ModelConnection): Promise<void> {
    const index = this.settings.connections.findIndex((item) => item.id === connection.id);
    if (index >= 0) this.settings.connections[index] = connection;
    else this.settings.connections.push(connection);
    if (!this.settings.activeConnectionId) this.settings.activeConnectionId = connection.id;
    await this.saveSettings();
  }

  async removeConnection(id: string): Promise<void> {
    this.settings.connections = this.settings.connections.filter((connection) => connection.id !== id);
    if (this.settings.activeConnectionId === id) this.settings.activeConnectionId = this.settings.connections[0]?.id ?? "";
    await this.saveSettings();
  }

  async rebuildIndex(): Promise<void> {
    const connection = this.getActiveConnection();
    const embedder = connection?.kind === "local" && connection.embeddingModel ? (texts: string[]) => this.modelClient.embed(connection, texts) : undefined;
    await this.indexer.rebuild(embedder);
  }

  async getSessions(): Promise<TaskSession[]> {
    return (await this.db.getAll<TaskSession>("sessions")).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSession(): Promise<TaskSession> {
    const now = Date.now();
    const session: TaskSession = { id: crypto.randomUUID(), title: "新会话", createdAt: now, updatedAt: now, messages: [], retrievalTrace: [] };
    await this.db.put("sessions", session);
    return session;
  }

  async saveSession(session: TaskSession): Promise<void> {
    session.updatedAt = Date.now();
    await this.db.put("sessions", session);
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.delete("sessions", id);
  }

  async applyProposal(proposal: ChangeProposal): Promise<void> {
    for (const change of proposal.changes.filter((item) => item.selected)) {
      const path = this.safePath(change.path);
      if (change.kind === "create") {
        await this.ensureParent(path);
        if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`目标已存在：${path}`);
        await this.app.vault.create(path, change.content ?? "");
      } else {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`文件不存在：${path}`);
        if (change.kind === "modify") await this.app.vault.modify(file, change.content ?? "");
        if (change.kind === "move") {
          const newPath = this.safePath(change.newPath ?? "");
          await this.ensureParent(newPath);
          await this.app.fileManager.renameFile(file, newPath);
        }
        if (change.kind === "delete") await this.app.vault.trash(file, true);
      }
    }
    proposal.status = "applied";
  }

  private scheduleUpdate(file: TFile): void {
    const existing = this.updateTimers.get(file.path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.updateTimers.delete(file.path);
      void this.indexer.updateFile(file).catch((error) => console.error("Vault Knowledge Agent index update failed", error));
    }, 900);
    this.updateTimers.set(file.path, timer);
  }

  private notifyViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KNOWLEDGE_AGENT)) {
      if (leaf.view instanceof KnowledgeAgentView) leaf.view.updateIndexStatus();
    }
  }

  private safePath(input: string): string {
    const path = normalizePath(input.replace(/\\/g, "/").trim());
    if (!path || path.startsWith("../") || path.includes("/../") || path.startsWith("/") || /^[a-z]:/i.test(path)) throw new Error(`路径超出当前 Vault：${input}`);
    if (path === ".obsidian" || path.startsWith(".obsidian/")) throw new Error("不允许修改 .obsidian 配置目录");
    return path;
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) await this.app.vault.createFolder(current);
      else if (existing instanceof TFile) throw new Error(`父路径不是文件夹：${current}`);
    }
  }

  private vaultKey(): string {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string; basePath?: string };
    const raw = adapter.getBasePath?.() ?? adapter.basePath ?? this.app.vault.getName();
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) { hash ^= raw.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16);
  }
}
