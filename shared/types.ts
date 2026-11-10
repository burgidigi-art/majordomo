// Types shared by the server and the web UI. Keep this file free of runtime imports.

export type RuntimeId =
  | 'anthropic'
  | 'claude-code'
  | 'openai'
  | 'codex'
  | 'gemini'
  | 'gemini-cli'
  | 'muse'
  | 'openrouter'
  | 'demo';

export type RuntimeKind = 'api' | 'cli';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RuntimeInfo {
  id: RuntimeId;
  kind: RuntimeKind;
  /** Vendor family, used for grouping and colour. */
  family: 'claude' | 'openai' | 'gemini' | 'muse' | 'openrouter' | 'demo';
  label: string;
  /** How this runtime is paid for / authenticated. */
  auth: string;
  /** True when a key is saved or the CLI binary is on PATH. */
  ready: boolean;
  /** Human-readable detail: masked key, CLI version, or what is missing. */
  detail: string;
  keySource?: 'saved' | 'env' | null;
  /** Can run the project manager itself (needs tool calling we control). */
  canManage: boolean;
  experimental?: string;
  setupHint: string;
}

export interface CrewProfile {
  id: string;
  name: string;
  /** What this crew member is good at; the PM reads this to route work. */
  strengths: string;
  runtime: RuntimeId;
  /** Empty string means "the runtime's default model". */
  model: string;
  effort?: Effort | null;
}

export interface Settings {
  userName: string;
  pm: { runtime: RuntimeId; model: string; effort?: Effort | null };
  crew: CrewProfile[];
  defaultCrewId: string;
  maxParallel: number;
  /** auto: workers act freely inside their workspace. ask: shell commands wait for approval. */
  approvalMode: 'auto' | 'ask';
  /** Compact an agent's history once a request's input passes this many tokens. */
  compactAtTokens: number;
  workspaceRoot: string;
  codexSandbox: 'workspace-write' | 'danger-full-access';
}

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';

export interface Project {
  id: string;
  name: string;
  goal: string;
  status: ProjectStatus;
  /** The PM's living brief for the project. */
  notes: string;
  workspace: string;
  hue: number;
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  brief: string;
  status: TaskStatus;
  crewId: string;
  crewName: string;
  runtime: RuntimeId;
  model: string;
  effort: Effort | null;
  dependsOn: string[];
  /** Latest one-line progress note from the worker. */
  statusLine: string;
  result: string;
  error: string;
  attempt: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** True when usage is covered by a subscription/CLI login rather than metered per token. */
  costIncluded: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** A file the user sent in from outside the dashboard (a photo or document from their phone). */
export interface Attachment {
  name: string;
  /** Absolute path of the saved copy in the inbox folder. */
  path: string;
  mime: string;
  size: number;
  /** An image small enough, and of a type, that a vision model can be shown directly. */
  image: boolean;
}

export type AgentEventType =
  | 'user'
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'notice'
  | 'error'
  | 'usage';

export interface AgentEvent {
  id: number;
  /** 'pm' or a task id. */
  agentId: string;
  ts: number;
  type: AgentEventType;
  data: any;
}

export interface Approval {
  id: string;
  agentId: string;
  tool: string;
  summary: string;
  detail: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
}

export interface Memory {
  id: string;
  text: string;
  createdAt: number;
}

export interface Reminder {
  id: string;
  note: string;
  dueAt: number;
  repeatMinutes: number | null;
}

export interface PmStatus {
  busy: boolean;
  queued: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface TelegramChat {
  id: number;
  name: string;
  pairedAt: number;
}

export type VoiceProvider = 'auto' | 'openai' | 'gemini' | 'command' | 'off';

export interface VoiceSettings {
  /** What turns a voice note into text. auto picks the first that is available. */
  provider: VoiceProvider;
  /** Model id for OpenAI or Gemini; empty means the default for that provider. */
  model: string;
  /** Local transcription command; `{file}` is replaced by the audio file's path. */
  command: string;
}

export interface VoiceStatus extends VoiceSettings {
  /** The service that will transcribe right now, or '' when none can. */
  using: string;
  /** What is missing, when nothing can transcribe. */
  problem: string;
}

export interface TelegramStatus {
  /** A bot token is saved (or set in the environment). */
  configured: boolean;
  /** The bot is polling Telegram for messages right now. */
  connected: boolean;
  botUsername: string;
  error: string;
  /** One-time code that links a Telegram chat to this Majordomo. */
  pairCode: string;
  chats: TelegramChat[];
  /** Also push the manager's own updates (work finished, approvals needed), not just replies. */
  notify: boolean;
  voice: VoiceStatus;
}

export interface AppState {
  settings: Settings;
  runtimes: RuntimeInfo[];
  projects: Project[];
  tasks: Task[];
  approvals: Approval[];
  memory: Memory[];
  reminders: Reminder[];
  pm: PmStatus;
  telegram: TelegramStatus;
  demo: boolean;
  version: string;
}

/** Messages pushed over the SSE stream. */
export type StreamMessage =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'delta'; agentId: string; block: string; type: 'text' | 'thinking'; text: string }
  | { kind: 'sync'; patch: Partial<AppState> & { removedProjects?: string[] } }
  | { kind: 'hello' };

export interface ModelOption {
  id: string;
  label?: string;
  inputPerM?: number;
  outputPerM?: number;
}

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}
