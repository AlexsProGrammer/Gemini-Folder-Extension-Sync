type AnyFn = (...args: any[]) => any;

type WebextApi = {
  storage: {
    local: {
      get: AnyFn;
      set: AnyFn;
    };
    onChanged: { addListener: AnyFn };
  };
  runtime: {
    sendMessage: AnyFn;
    onMessage: { addListener: AnyFn };
    lastError?: { message?: string } | null;
  };
  tabs?: unknown;
};

const globalApi = globalThis as typeof globalThis & {
  browser?: WebextApi;
  chrome?: WebextApi;
};

let polyfillPromise: Promise<WebextApi | null> | null = null;

export function ensureWebextApi(): Promise<WebextApi | null> {
  const existing = globalApi.browser ?? globalApi.chrome;
  if (existing) {
    return Promise.resolve(existing);
  }
  if (!polyfillPromise) {
    polyfillPromise = import('webextension-polyfill')
      .then((module) => {
        const candidate = (module as { default?: WebextApi; browser?: WebextApi }).default
          ?? (module as { browser?: WebextApi }).browser
          ?? globalApi.browser
          ?? globalApi.chrome;
        return candidate ?? null;
      })
      .catch(() => null);
  }
  return polyfillPromise;
}

export const webext: WebextApi = new Proxy({} as WebextApi, {
  get(_target, prop: string | symbol) {
    const api = globalApi.browser ?? globalApi.chrome;
    if (!api) return undefined;
    return Reflect.get(api as object, prop, api as object);
  },
  has(_target, prop: string | symbol) {
    const api = globalApi.browser ?? globalApi.chrome;
    return Boolean(api && Reflect.has(api as object, prop));
  }
});

function invokeCompat<T>(fn: AnyFn, args: unknown[]): Promise<T> {
  try {
    const maybePromise = fn(...args);
    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise as Promise<T>;
    }
  } catch {
    // Fall through to callback mode for Chrome APIs.
  }

  return new Promise<T>((resolve, reject) => {
    fn(...args, (value: T) => {
      const runtimeError = globalApi.chrome?.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'WebExtension API call failed.'));
        return;
      }
      resolve(value);
    });
  });
}

async function resolveApi(): Promise<WebextApi> {
  const api = globalApi.browser ?? globalApi.chrome ?? (await ensureWebextApi());
  if (!api) {
    throw new Error('WebExtension API is not available in this environment.');
  }
  return api;
}

export async function storageLocalGet<T = Record<string, unknown>>(
  keys?: string | string[] | Record<string, unknown> | null
): Promise<T> {
  const api = await resolveApi();
  return invokeCompat<T>(api.storage.local.get.bind(api.storage.local), [keys]);
}

export async function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  const api = await resolveApi();
  return invokeCompat<void>(api.storage.local.set.bind(api.storage.local), [items]);
}

export async function runtimeSendMessage<TResponse = unknown>(message: unknown): Promise<TResponse> {
  const api = await resolveApi();
  return invokeCompat<TResponse>(api.runtime.sendMessage.bind(api.runtime), [message]);
}

export function runtimeLastErrorMessage(): string | null {
  const error = globalApi.chrome?.runtime?.lastError ?? globalApi.browser?.runtime?.lastError;
  return error?.message || null;
}