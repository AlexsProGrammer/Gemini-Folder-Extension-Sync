import { BackgroundRequest, BackgroundResponse, ChatRef, Project, StoredState } from './shared/types';
import type {
  EncryptedSyncEnvelope,
  RemoteSyncBlob,
  SyncApiResponse,
  SyncMessage,
  SyncPushMessage
} from './shared/types';
import { RemoteSyncBlobSchema, SyncConfirmationSchema } from './shared/schemas';
import { createEmptyState, loadState, saveState } from './shared/storage';
import { webext } from './shared/webext';

let cachedState: StoredState | null = null;
let loadPromise: Promise<StoredState> | null = null;

async function getState(): Promise<StoredState> {
  if (cachedState) {
    return cachedState;
  }
  if (!loadPromise) {
    loadPromise = loadState().catch(() => createEmptyState());
  }
  cachedState = await loadPromise;
  return cachedState;
}

async function persist(state: StoredState): Promise<void> {
  cachedState = state;
  await saveState(state);
}

function upsertProject(state: StoredState, project: Project): StoredState {
  const idx = state.projects.findIndex((item) => item.id === project.id);
  if (idx >= 0) {
    state.projects[idx] = {
      ...state.projects[idx],
      ...project,
      updatedAt: project.updatedAt ?? Date.now()
    };
  } else {
    state.projects.push(project);
  }
  return state;
}

function renameProject(state: StoredState, projectId: string, name: string): StoredState {
  const project = state.projects.find((item) => item.id === projectId);
  if (project) {
    project.name = name;
    project.updatedAt = Date.now();
  }
  return state;
}

function deleteProject(state: StoredState, projectId: string): StoredState {
  const doomed = new Set<string>([projectId]);
  let grew = true;
  while (grew) {
    grew = false;
    state.projects.forEach((item) => {
      if (item.parentId && doomed.has(item.parentId) && !doomed.has(item.id)) {
        doomed.add(item.id);
        grew = true;
      }
    });
  }

  state.projects = state.projects.filter((item) => !doomed.has(item.id));
  Object.values(state.chatIndex).forEach((chat) => {
    if (chat.projectId && doomed.has(chat.projectId)) {
      chat.projectId = null;
    }
  });
  return state;
}

function moveChat(state: StoredState, conversationId: string, projectId: string | null): StoredState {
  const existing = state.chatIndex[conversationId];
  state.chatIndex[conversationId] = {
    conversationId,
    title: existing?.title ?? '',
    isPinned: existing?.isPinned ?? false,
    projectId,
    updatedAt: Date.now(),
    lastUrl: existing?.lastUrl
  };
  return state;
}

function setChatPinned(state: StoredState, conversationId: string, isPinned: boolean): StoredState {
  const existing = state.chatIndex[conversationId];
  if (!existing) return state;
  state.chatIndex[conversationId] = { ...existing, isPinned, updatedAt: Date.now() };
  return state;
}

function upsertChatRefs(state: StoredState, chats: ChatRef[]): StoredState {
  chats.forEach((chat) => {
    const existing = state.chatIndex[chat.conversationId];
    state.chatIndex[chat.conversationId] = {
      conversationId: chat.conversationId,
      title: chat.title || existing?.title || '',
      isPinned: typeof chat.isPinned === 'boolean' ? chat.isPinned : (existing?.isPinned ?? false),
      projectId: chat.projectId ?? existing?.projectId ?? null,
      updatedAt: chat.updatedAt ?? existing?.updatedAt ?? Date.now(),
      lastUrl: chat.lastUrl ?? existing?.lastUrl
    };
  });
  return state;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/^_+|_+$/g, '') || 'project';
}

function exportProjectJson(state: StoredState, projectId: string): BackgroundResponse {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    return { ok: false, error: 'Project not found' };
  }
  const chats = Object.values(state.chatIndex)
    .filter((chat) => chat.projectId === project.id)
    .map((chat) => ({ conversationId: chat.conversationId, title: chat.title }));
  const payload = {
    project: {
      id: project.id,
      name: project.name,
      icon: project.icon,
      color: project.color ?? null,
      isPinned: project.isPinned === true,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      sortIndex: project.sortIndex
    },
    chats
  };
  const json = JSON.stringify(payload, null, 2);
  const filename = `${sanitizeFilename(project.name)}.json`;
  return { ok: true, json, filename };
}

function updateUiPrefs(state: StoredState, prefs: Partial<StoredState['uiPrefs']>): StoredState {
  state.uiPrefs = { ...state.uiPrefs, ...prefs };
  return state;
}

async function handleMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  switch (message.type) {
    case 'refreshStateCache': {
      cachedState = await loadState().catch(() => createEmptyState());
      return { ok: true, state: cachedState };
    }
  }

  const state = await getState();

  switch (message.type) {
    case 'getState':
      return { ok: true, state };
    case 'upsertProject':
      await persist(upsertProject(state, message.project));
      return { ok: true, state };
    case 'renameProject':
      await persist(renameProject(state, message.projectId, message.name));
      return { ok: true, state };
    case 'setProjectPinned': {
      const project = state.projects.find((item) => item.id === message.projectId);
      if (!project) return { ok: false, error: 'Project not found' };
      const nextState = {
        ...state,
        projects: state.projects.map((item) => item.id === project.id
          ? { ...item, isPinned: message.isPinned, updatedAt: Date.now() }
          : item)
      };
      // 写入成功后再替换缓存，避免失败时显示未保存的置顶状态。
      await saveState(nextState);
      cachedState = nextState;
      return { ok: true, state: nextState };
    }
    case 'deleteProject':
      await persist(deleteProject(state, message.projectId));
      return { ok: true, state };
    case 'moveChat':
      await persist(moveChat(state, message.conversationId, message.projectId));
      return { ok: true, state };
    case 'setChatPinned':
      await persist(setChatPinned(state, message.conversationId, message.isPinned));
      return { ok: true, state };
    case 'upsertChatRefs':
      await persist(upsertChatRefs(state, message.chats));
      return { ok: true, state };
    case 'exportProject': {
      return exportProjectJson(state, message.projectId);
    }
    case 'updateUiPrefs':
      await persist(updateUiPrefs(state, message.prefs));
      return { ok: true, state };
    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

webext.runtime.onMessage.addListener((
  message: BackgroundRequest | SyncMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundResponse | SyncApiResponse<unknown>) => void
) => {
  if (isSyncMessage(message)) {
    handleSyncMessage(message)
      .then((response) => sendResponse(response))
      .catch((error: Error) => sendResponse({
        success: false,
        error: 'network_error',
        message: error.message
      }));
    return true;
  }

  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

/* ------------------------------------------------------------------ *
 * Background CORS proxy: content scripts on gemini.google.com cannot
 * dispatch cross-origin requests to the user's self-hosted VPS, so all
 * sync HTTP traffic is proxied through this privileged context.
 * ------------------------------------------------------------------ */

const SYNC_FETCH_TIMEOUT_MS = 10_000;

type SyncHandlerResponse = SyncApiResponse<unknown>;

function isSyncMessage(message: unknown): message is SyncMessage {
  if (!message || typeof message !== 'object') return false;
  const action = (message as { action?: unknown }).action;
  return action === 'SYNC_PULL' || action === 'SYNC_PUSH';
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '');
}

function syncEndpoint(serverUrl: string, accountId: string): string {
  return `${normalizeServerUrl(serverUrl)}/api/v1/sync/${accountId}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function networkFailure(error: unknown): SyncHandlerResponse {
  return {
    success: false,
    error: 'network_error',
    message: error instanceof Error ? error.message : String(error)
  };
}

async function handleSyncPull(
  accountId: string,
  serverUrl: string,
  apiKey: string
): Promise<SyncHandlerResponse> {
  try {
    const response = await fetchWithTimeout(syncEndpoint(serverUrl, accountId), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 200) {
      const body = await parseJsonResponse(response);
      const parsed = RemoteSyncBlobSchema.safeParse(body);
      if (!parsed.success) {
        return { success: false, error: 'network_error', status: 200, message: 'Malformed sync blob.' };
      }
      return { success: true, data: parsed.data as RemoteSyncBlob };
    }
    if (response.status === 404) {
      return { success: false, error: 'not_found', status: 404 };
    }
    if (response.status === 401) {
      return { success: false, error: 'unauthorized', status: 401 };
    }
    return { success: false, error: 'network_error', status: response.status };
  } catch (error) {
    return networkFailure(error);
  }
}

async function handleSyncPush(message: SyncPushMessage): Promise<SyncHandlerResponse> {
  const { accountId, serverUrl, apiKey, data } = message;
  try {
    const response = await fetchWithTimeout(syncEndpoint(serverUrl, accountId), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data satisfies EncryptedSyncEnvelope)
    });

    if (response.status === 200 || response.status === 201) {
      const body = await parseJsonResponse(response);
      const parsed = SyncConfirmationSchema.safeParse(body);
      if (parsed.success) {
        return { success: true, data: { version: parsed.data.version } };
      }
      return { success: true, data: { version: data.version } };
    }
    if (response.status === 409) {
      const body = await parseJsonResponse(response);
      const serverState = (body as { serverState?: unknown } | null)?.serverState;
      const parsedServerState = RemoteSyncBlobSchema.safeParse(serverState);
      return {
        success: false,
        error: 'conflict',
        status: 409,
        ...(parsedServerState.success ? { serverState: parsedServerState.data as RemoteSyncBlob } : {})
      };
    }
    if (response.status === 401) {
      return { success: false, error: 'unauthorized', status: 401 };
    }
    return { success: false, error: 'network_error', status: response.status };
  } catch (error) {
    return networkFailure(error);
  }
}

function handleSyncMessage(message: SyncMessage): Promise<SyncHandlerResponse> {
  if (message.action === 'SYNC_PULL') {
    return handleSyncPull(message.accountId, message.serverUrl, message.apiKey);
  }
  return handleSyncPush(message);
}

