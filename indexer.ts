import { App, getAllTags, TFile } from "obsidian";
import { LocalDatabase } from "./storage";
import { IndexedDocument, IndexStatus, SearchHit } from "./types";

type Embedder = (texts: string[]) => Promise<number[][]>;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export class VaultIndexer {
  private documents = new Map<string, IndexedDocument>();
  private status: IndexStatus = { state: "idle", total: 0, indexed: 0 };

  constructor(
    private readonly app: App,
    private readonly db: LocalDatabase,
    private readonly extensions: () => string[],
    private readonly onStatus: (status: IndexStatus) => void
  ) {}

  async initialize(): Promise<void> {
    const stored = await this.db.getAll<IndexedDocument>("documents");
    for (const doc of stored) this.documents.set(doc.path, doc);
    this.setStatus({
      state: stored.length ? "ready" : "idle",
      total: stored.length,
      indexed: stored.length,
      updatedAt: stored.length ? Date.now() : undefined
    });
  }

  getStatus(): IndexStatus { return { ...this.status }; }

  getDocument(path: string): IndexedDocument | undefined { return this.documents.get(path); }

  getAllDocuments(): IndexedDocument[] { return [...this.documents.values()]; }

  async rebuild(embedder?: Embedder): Promise<void> {
    const allowed = new Set(this.extensions().map((ext) => ext.toLowerCase().replace(/^\./, "")));
    const files = this.app.vault.getFiles().filter((file) => allowed.has(file.extension.toLowerCase()) || IMAGE_EXTENSIONS.has(file.extension.toLowerCase()));
    this.documents.clear();
    await this.db.clear("documents");
    this.setStatus({ state: "building", total: files.length, indexed: 0, message: "正在读取 Vault…" });

    try {
      const docs: IndexedDocument[] = [];
      for (let i = 0; i < files.length; i++) {
        const doc = await this.makeDocument(files[i]);
        docs.push(doc);
        this.documents.set(doc.path, doc);
        await this.db.put("documents", doc);
        this.setStatus({ state: "building", total: files.length, indexed: i + 1, message: `正在索引 ${doc.path}` });
      }

      const embeddable = docs.filter((doc) => Boolean(doc.content.trim()));
      if (embedder && embeddable.length) {
        const batchSize = 12;
        for (let start = 0; start < embeddable.length; start += batchSize) {
          const batch = embeddable.slice(start, start + batchSize);
          const inputs = batch.map((doc) => `${doc.title}\n${doc.content.slice(0, 6000)}`);
          const vectors = await embedder(inputs);
          for (let i = 0; i < batch.length; i++) {
            batch[i].embedding = vectors[i];
            await this.db.put("documents", batch[i]);
          }
          this.setStatus({ state: "building", total: embeddable.length, indexed: Math.min(start + batch.length, embeddable.length), message: "正在生成语义索引…" });
        }
      }

      this.setStatus({ state: "ready", total: docs.length, indexed: docs.length, updatedAt: Date.now() });
    } catch (error) {
      this.setStatus({ state: "error", total: files.length, indexed: this.documents.size, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async updateFile(file: TFile, embedder?: Embedder): Promise<void> {
    const allowed = new Set(this.extensions().map((ext) => ext.toLowerCase().replace(/^\./, "")));
    if (!allowed.has(file.extension.toLowerCase()) && !IMAGE_EXTENSIONS.has(file.extension.toLowerCase())) return;
    const doc = await this.makeDocument(file);
    if (embedder) {
      const [vector] = await embedder([`${doc.title}\n${doc.content.slice(0, 6000)}`]);
      doc.embedding = vector;
    }
    this.documents.set(doc.path, doc);
    await this.db.put("documents", doc);
    this.setStatus({ state: "ready", total: this.documents.size, indexed: this.documents.size, updatedAt: Date.now() });
  }

  async removePath(path: string): Promise<void> {
    this.documents.delete(path);
    await this.db.delete("documents", path);
    this.setStatus({ state: this.documents.size ? "ready" : "idle", total: this.documents.size, indexed: this.documents.size, updatedAt: Date.now() });
  }

  search(query: string, limit = 8, queryEmbedding?: number[]): SearchHit[] {
    const terms = this.terms(query);
    const hits: SearchHit[] = [];
    for (const doc of this.documents.values()) {
      const lowerPath = doc.path.toLowerCase();
      const lowerTitle = doc.title.toLowerCase();
      const lowerContent = doc.content.toLowerCase();
      let score = 0;
      let firstMatch = -1;
      for (const term of terms) {
        if (lowerTitle.includes(term)) score += 12;
        if (lowerPath.includes(term)) score += 7;
        if (doc.tags.some((tag) => tag.toLowerCase().includes(term))) score += 6;
        if (doc.headings.some((heading) => heading.toLowerCase().includes(term))) score += 5;
        const index = lowerContent.indexOf(term);
        if (index >= 0) {
          score += 2 + Math.min(5, lowerContent.split(term).length - 1);
          if (firstMatch < 0) firstMatch = index;
        }
      }
      if (queryEmbedding && doc.embedding?.length === queryEmbedding.length) score += Math.max(0, this.cosine(queryEmbedding, doc.embedding)) * 14;
      if (score <= 0) continue;
      hits.push({
        path: doc.path,
        title: doc.title,
        score,
        snippet: this.snippet(doc.content, firstMatch),
        headings: doc.headings.slice(0, 8),
        tags: doc.tags.slice(0, 12),
        imageRefs: doc.imageRefs.slice(0, 8)
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 20)));
  }

  getBacklinks(path: string): string[] {
    const backlinks: string[] = [];
    for (const [source, links] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (Object.prototype.hasOwnProperty.call(links, path)) backlinks.push(source);
    }
    return backlinks;
  }

  listTags(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();
    for (const doc of this.documents.values()) {
      for (const tag of doc.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  }

  audit(): Record<string, unknown> {
    const docs = [...this.documents.values()].filter((doc) => doc.extension !== "png" && doc.extension !== "jpg" && doc.extension !== "jpeg" && doc.extension !== "gif" && doc.extension !== "webp" && doc.extension !== "svg");
    const orphans = docs.filter((doc) => doc.links.length === 0 && this.getBacklinks(doc.path).length === 0).map((doc) => doc.path);
    const titleGroups = new Map<string, string[]>();
    for (const doc of docs) {
      const key = doc.title.trim().toLowerCase();
      if (!key) continue;
      const paths = titleGroups.get(key) ?? [];
      paths.push(doc.path);
      titleGroups.set(key, paths);
    }
    const duplicateTitles = [...titleGroups.values()].filter((paths) => paths.length > 1);
    const emptyDocuments = docs.filter((doc) => !doc.content.trim()).map((doc) => doc.path);
    const untagged = docs.filter((doc) => doc.extension === "md" && doc.tags.length === 0).map((doc) => doc.path);
    return { totalDocuments: docs.length, orphans, duplicateTitles, emptyDocuments, untagged, tags: this.listTags() };
  }

  private async makeDocument(file: TFile): Promise<IndexedDocument> {
    const isImage = IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
    const content = isImage ? "" : await this.app.vault.cachedRead(file);
    const cache = file.extension === "md" ? this.app.metadataCache.getFileCache(file) : null;
    const tags = cache ? (getAllTags(cache) ?? []) : [];
    const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].map((link) => link.link);
    const imageRefs = (cache?.embeds ?? []).map((embed) => embed.link).filter((link) => /\.(png|jpe?g|gif|webp|svg)$/i.test(link));
    const headings = (cache?.headings ?? []).map((heading) => heading.heading);
    const properties = cache?.frontmatter ? { ...cache.frontmatter } : {};
    return {
      path: file.path,
      extension: file.extension,
      title: file.basename,
      content,
      mtime: file.stat.mtime,
      size: file.stat.size,
      tags,
      links,
      headings,
      imageRefs: isImage ? [file.path] : imageRefs,
      properties
    };
  }

  private setStatus(status: IndexStatus): void {
    this.status = status;
    this.onStatus({ ...status });
  }

  private terms(query: string): string[] {
    const normalized = query.toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ");
    const stop = new Set(["这个", "那个", "什么", "怎么", "可以", "帮我", "笔记", "知识", "vault", "agent", "please", "about"]);
    const values = new Set(normalized.split(/\s+/).filter((value) => value.length >= 2 && !stop.has(value)));
    for (const match of normalized.match(/[\u3400-\u9fff]{3,}/g) ?? []) {
      values.add(match);
      for (let i = 0; i < Math.min(match.length - 1, 12); i++) values.add(match.slice(i, i + 2));
    }
    return [...values].slice(0, 32);
  }

  private snippet(content: string, match: number): string {
    if (!content) return "";
    const start = match >= 0 ? Math.max(0, match - 260) : 0;
    return content.slice(start, start + 900).replace(/\n{3,}/g, "\n\n").trim();
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
  }
}
