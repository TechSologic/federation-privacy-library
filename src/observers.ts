/** At most one executing and one latest pending notification per observer.
 * Diagnostics never participate in durable work or shutdown. Async rejections
 * are contained. Slow observers coalesce intermediate notifications.
 */
export class ObserverDispatcher {
  private readonly active = new WeakMap<object, { next?: () => void | Promise<void> }>();

  dispatch(observer: object, callback: () => void | Promise<void>): void {
    const current = this.active.get(observer);
    if (current) {
      current.next = callback;
      return;
    }
    const state: { next?: () => void | Promise<void> } = {};
    this.active.set(observer, state);
    let result: void | Promise<void>;
    try {
      result = callback();
    } catch {
      this.active.delete(observer);
      return;
    }
    if (!result) {
      this.active.delete(observer);
      return;
    }
    void Promise.resolve(result)
      .catch(() => {})
      .then(() => {
        this.active.delete(observer);
        if (state.next) this.dispatch(observer, state.next);
      });
  }
}
