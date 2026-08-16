export type ConnectionKind = "local" | "cloud";
export type MessageRole = "user" | "assistant";
export type ChangeKind = "create" | "modify" | "move" | "delete";

export interface ModelConnection {
  id: string;
  name: string;
  baseUrl: string;
  kind: ConnectionKind;
  models: string[];
  manualModels: string[];
  chatModel: string;
  embeddingModel: string;
}

export interface AgentSettings {
  connections: ModelConnection[];
  activeConnectionId: string;
  filesystemMode: boolean;
  allowModelKnowledge: boolean;
  previewCloudContext: boolean;
  indexedExtensions: string[];
}

export const DEFAULT_SETTINGS: AgentSettings = {
  connections: [],
  activeConnectionId: "",
  filesystemMode: false,
  allowModelKnowledge: false,
  previewCloudContext: true,
  indexedExtensions: ["md", "canvas", "base", "txt"]
};

export interface IndexedDocument {
  path: string;
  extension: string;
  title: string;
  content: string;
  mtime: number;
  size: number;
  tags: string[];
  links: string[];
  headings: string[];
  imageRefs: string[];
  properties: Record<string, unknown>;
  embedding?: number[];
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  headings: string[];
  tags: string[];
  imageRefs: string[];
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  evidence?: string[];
}

export interface ProposedChange {
  id: string;
  kind: ChangeKind;
  path: string;
  newPath?: string;
  content?: string;
  reason: string;
  evidence: string[];
  selected: boolean;
}

export interface ChangeProposal {
  id: string;
  title: string;
  summary: string;
  changes: ProposedChange[];
  createdAt: number;
  status: "pending" | "applied" | "dismissed";
}

export interface TaskSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  retrievalTrace: string[];
  proposal?: ChangeProposal;
}

export interface IndexStatus {
  state: "idle" | "building" | "ready" | "error";
  total: number;
  indexed: number;
  updatedAt?: number;
  message?: string;
}

export interface SharedContextPreview {
  question: string;
  history: ChatMessage[];
  evidence: SearchHit[];
  connectionName: string;
  model: string;
}
