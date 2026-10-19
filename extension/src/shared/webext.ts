type AnyFn = (...args: any[]) => any;

type WebextApi = {
  storage: {
    local: {
      get: AnyFn;
      set: AnyFn;
      clear?: AnyFn;
    };
    onChanged: { addListener: AnyFn };
  };
  runtime: {
    sendMessage: AnyFn;
    onMessage: { addListener: AnyFn };
    lastError?: { message?: string } | null;
  };
  permissions?: {
    contains: AnyFn;
    request: AnyFn;
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

/**
 * Clones a value into a plain, same-compartment object.
 *
 * Firefox hands content scripts Xray-wrapped values from `storage.local.get`
 * (and from some runtime responses). Xray wrappers block prototype-chain
 * access — reading `.constructor` throws `Permission denied to access
 * property "constructor"` — which breaks schema validation (zod's
 * `isPlainObject`) and any `instanceof`/method call on the value. Storage
 * values are JSON-serializable by definition, so a JSON round-trip is a
 * lossless way to obtain plain objects.
 */
export function sanitizeStorageValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (error) {
    // TEMP diagnostics (gp-debug): if this fires, storage handed us a value the
    // JSON round-trip cannot normalize and downstream code sees raw data.
    console.warn('[gp-debug] storage value JSON round-trip failed; returning raw cross-compartment value', error);
    // Fall back to the raw value; callers must tolerate cross-compartment data.
    return value;
  }
}

/**
 * TEMP diagnostics (gp-debug): runs one pipeline step and, when it throws,
 * logs the failing step label before rethrowing the original error.
 *
 * Xray "Permission denied" SecurityErrors carry no JS stack, so step labels
 * are the only way to localize the throwing statement in a minified build.
 * Remove once the failing step is known.
 */
export async function debugStep<T>(label: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(`[gp-debug] step failed: ${label}:`, errorMessage(error));
    throw error;
  }
}

export async function storageLocalGet<T = Record<string, unknown>>(
  keys?: string | string[] | Record<string, unknown> | null
): Promise<T> {
  const api = await resolveApi();
  const result = await invokeCompat<T>(api.storage.local.get.bind(api.storage.local), [keys]);
  return sanitizeStorageValue(result);
}

export async function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  const api = await resolveApi();
  return invokeCompat<void>(api.storage.local.set.bind(api.storage.local), [items]);
}

export async function runtimeSendMessage<TResponse = unknown>(message: unknown): Promise<TResponse> {
  const api = await resolveApi();
  const response = await invokeCompat<TResponse>(api.runtime.sendMessage.bind(api.runtime), [message]);
  return sanitizeStorageValue(response);
}

/** Reads `error.name` without `instanceof` (safe across compartments). */
export function errorName(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  try {
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/** Reads `error.message` without `instanceof` (safe across compartments). */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return String(error);
  try {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  } catch {
    // Fall through to String().
  }
  return String(error);
}

/** Reads `error.stack` without `instanceof` (safe across compartments). */
export function errorStack(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  try {
    const stack = (error as { stack?: unknown }).stack;
    return typeof stack === 'string' ? stack : '';
  } catch {
    return '';
  }
}

/** Deletes every key from extension local storage (Danger Zone wipe). */
export async function storageLocalClear(): Promise<void> {
  const api = await resolveApi();
  const clear = api.storage.local.clear;
  if (typeof clear !== 'function') {
    throw new Error('storage.local.clear is not available in this context.');
  }
  return invokeCompat<void>(clear.bind(api.storage.local), []);
}

export function runtimeLastErrorMessage(): string | null {
  const error = globalApi.chrome?.runtime?.lastError ?? globalApi.browser?.runtime?.lastError;
  return error?.message || null;
}

/**
 * Checks whether the extension already has host permission for the given
 * origins (e.g. `["https://sync.example.com/*"]`).
 *
 * Returns `null` when the permissions API is not available in the current
 * context (Firefox does not expose `browser.permissions` to content scripts).
 * Callers should treat `null` as "cannot ask here" and rely on the
 * statically-declared `host_permissions` instead.
 */
export async function permissionsContains(origins: string[]): Promise<boolean | null> {
  const api = await resolveApi();
  const permissions = api.permissions;
  if (!permissions || typeof permissions.contains !== 'function') {
    console.warn('[gemini-projects] permissions API unavailable; cannot check host permission.');
    return null;
  }
  const granted = await invokeCompat<boolean>(permissions.contains.bind(permissions), [origins]);
  return Boolean(granted);
}

/**
 * Requests host permission for the given origins. Must be called from within
 * a user gesture (e.g. a button click handler).
 *
 * Returns `true` when granted, `false` when denied, and `null` when the
 * permissions API is not available in the current context.
 */
export async function permissionsRequest(origins: string[]): Promise<boolean | null> {
  const api = await resolveApi();
  const permissions = api.permissions;
  if (!permissions || typeof permissions.request !== 'function') {
    console.warn('[gemini-projects] permissions API unavailable; cannot request host permission.');
    return null;
  }
  const granted = await invokeCompat<boolean>(permissions.request.bind(permissions), [origins]);
  return Boolean(granted);
}