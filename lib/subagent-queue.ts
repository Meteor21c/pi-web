export type SubagentQueueState = "queued" | "running";

interface QueueItem<T> {
  parentId: string;
  run: () => Promise<T>;
  onState: (state: SubagentQueueState) => void;
  onCancel?: () => void | Promise<void>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  state: SubagentQueueState;
  cancelled: boolean;
}

type ParentQueue = {
  limit: number;
  active: number;
};

export interface EnqueuedSubagent<T> {
  promise: Promise<T>;
  cancel(): boolean;
}

/** FIFO across eligible jobs, with both per-parent and shared running limits. */
export class SubagentQueue<T> {
  private readonly parents = new Map<string, ParentQueue>();
  private readonly pending: QueueItem<T>[] = [];
  private active = 0;

  constructor(
    private readonly maxConcurrent = Infinity,
    private readonly currentParentLimit?: () => number | undefined,
  ) {}

  enqueue(
    parentId: string,
    limit: number,
    run: () => Promise<T>,
    onState: (state: SubagentQueueState) => void,
    onCancel?: () => void,
  ): EnqueuedSubagent<T> {
    const parent = this.parents.get(parentId) ?? { limit: 1, active: 0 };
    parent.limit = Math.max(1, Math.floor(limit) || 1);
    let item!: QueueItem<T>;
    const promise = new Promise<T>((resolve, reject) => {
      item = { parentId, run, onState, onCancel, resolve, reject, state: "queued", cancelled: false };
    });
    this.pending.push(item);
    this.parents.set(parentId, parent);
    try {
      onState("queued");
      this.pump();
    } catch (error) {
      item.cancelled = true;
      const index = this.pending.indexOf(item);
      if (index !== -1) this.pending.splice(index, 1);
      this.removeIdleParent(parentId, parent);
      item.reject(error);
    }
    return {
      promise,
      cancel: () => {
        if (item.state !== "queued" || item.cancelled) return false;
        item.cancelled = true;
        const index = this.pending.indexOf(item);
        if (index !== -1) this.pending.splice(index, 1);
        try {
          Promise.resolve(item.onCancel?.()).then(
            () => item.resolve(undefined as T),
            (error) => item.reject(error),
          );
        } catch (error) {
          item.reject(error);
        }
        this.removeIdleParent(parentId, parent);
        this.pump();
        return true;
      },
    };
  }

  private removeIdleParent(parentId: string, parent: ParentQueue): void {
    if (parent.active === 0 && !this.pending.some((item) => item.parentId === parentId)) {
      this.parents.delete(parentId);
    }
  }

  private pump(): void {
    const currentLimit = this.currentParentLimit?.();
    while (this.active < this.maxConcurrent) {
      const index = this.pending.findIndex((item) => {
        const parent = this.parents.get(item.parentId)!;
        return parent.active < (currentLimit ?? parent.limit);
      });
      if (index === -1) return;
      const [item] = this.pending.splice(index, 1);
      const parent = this.parents.get(item.parentId)!;
      item.state = "running";
      parent.active += 1;
      this.active += 1;
      let result: Promise<T>;
      try {
        item.onState("running");
        result = item.run();
      } catch (error) {
        result = Promise.reject(error);
      }
      void result.then(item.resolve, item.reject).finally(() => {
        parent.active -= 1;
        this.active -= 1;
        this.removeIdleParent(item.parentId, parent);
        this.pump();
      });
    }
  }
}
