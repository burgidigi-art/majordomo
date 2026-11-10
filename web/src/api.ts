import type { AgentEvent, AppState, FileEntry, GoogleStatus, ModelOption, Project, RuntimeId, Settings, TelegramStatus, VoiceSettings } from '../../shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw new Error(json?.error ?? (text || `Request failed (${res.status})`));
  return json as T;
}

const post = <T = { ok: true }>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  state: () => request<AppState>('/api/state'),
  events: (agentId: string) => request<AgentEvent[]>(`/api/agents/${encodeURIComponent(agentId)}/events?limit=1500`),
  chat: (text: string) => post('/api/chat', { text }),
  stopPm: () => post('/api/pm/stop'),
  resetPm: () => post('/api/pm/reset'),

  createProject: (body: { name: string; goal?: string; workspacePath?: string }) => post<Project>('/api/projects', body),
  updateProject: (id: string, patch: Partial<Project>) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: string) => request(`/api/projects/${id}`, { method: 'DELETE' }),
  files: (id: string, path: string) => request<FileEntry[]>(`/api/projects/${id}/files?path=${encodeURIComponent(path)}`),
  file: (id: string, path: string) =>
    request<{ content: string; size: number; note?: string }>(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`),

  cancelTask: (id: string) => post(`/api/tasks/${id}/cancel`),
  retryTask: (id: string) => post(`/api/tasks/${id}/retry`),
  messageTask: (id: string, text: string) => post(`/api/tasks/${id}/message`, { text }),
  approve: (id: string, approve: boolean) => post(`/api/approvals/${id}`, { approve }),

  saveSettings: (patch: Partial<Settings>) => request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  saveKey: (runtime: RuntimeId, key: string) =>
    request(`/api/runtimes/${runtime}/key`, { method: 'PUT', body: JSON.stringify({ key }) }),
  removeKey: (runtime: RuntimeId) => request(`/api/runtimes/${runtime}/key`, { method: 'DELETE' }),
  models: (runtime: RuntimeId) => request<ModelOption[]>(`/api/runtimes/${runtime}/models`),
  test: (runtime: RuntimeId) => post<{ ok: boolean; message: string }>(`/api/runtimes/${runtime}/test`),
  adopt: (runtime: RuntimeId, model: string) => post('/api/setup/adopt', { runtime, model }),

  saveTelegram: (body: { token?: string; notify?: boolean; voice?: Partial<VoiceSettings> }) =>
    request<TelegramStatus>('/api/telegram', { method: 'PUT', body: JSON.stringify(body) }),
  removeTelegram: () => request<TelegramStatus>('/api/telegram', { method: 'DELETE' }),
  newPairCode: () => post<TelegramStatus>('/api/telegram/pair-code'),
  unpairChat: (id: number) => request<TelegramStatus>(`/api/telegram/chats/${id}`, { method: 'DELETE' }),

  saveGoogleClient: (clientId: string, clientSecret: string) =>
    request<GoogleStatus>('/api/google', { method: 'PUT', body: JSON.stringify({ clientId, clientSecret }) }),
  disconnectGoogle: (forget: boolean) => request<GoogleStatus>(`/api/google${forget ? '?forget=1' : ''}`, { method: 'DELETE' }),

  forget: (id: string) => request(`/api/memory/${id}`, { method: 'DELETE' }),
  cancelReminder: (id: string) => request(`/api/reminders/${id}`, { method: 'DELETE' }),
};
