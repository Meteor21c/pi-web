/**
 * Serialize package/settings mutations within one local Magent process.
 *
 * The package manager writes both the Pi package directory and settings.json.
 * Keeping a small process-wide queue prevents an automatic starter install from
 * racing a manual update/remove action issued by the Plugins screen. This is a
 * coordination aid, not a cross-process filesystem lock; Pi's own settings and
 * npm package-manager locks still protect the files when another process is
 * active.
 */

type LockMap = Map<string, Promise<void>>;

const globalState = globalThis as typeof globalThis & {
  __magentPluginOperationLocks?: LockMap;
};

function locks(): LockMap {
  return globalState.__magentPluginOperationLocks ??= new Map<string, Promise<void>>();
}

export async function withPluginOperationLock<T>(
  key: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const queue = locks();
  const previous = queue.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queue.set(key, current);

  await previous?.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (queue.get(key) === current) queue.delete(key);
  }
}

