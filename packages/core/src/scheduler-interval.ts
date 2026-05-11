/**
 * Interval Scheduler — default setInterval-based SchedulerPlugin.
 *
 * Swap for cron-based (croner) or distributed (BullMQ) schedulers.
 */
import type { SchedulerPlugin, SchedulerHandle } from "./layers/index";

export function createIntervalScheduler(): SchedulerPlugin {
  const handles = new Map<string, ReturnType<typeof setInterval>>();
  const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  let counter = 0;

  return {
    name: "@the-brain/scheduler-interval",

    schedule(name: string, intervalMs: number, task: () => Promise<void>): SchedulerHandle {
      const id = `sched-${++counter}`;
      const handle = setInterval(async () => {
        try {
          await task();
        } catch (err) {
          console.error(`[Scheduler] Task "${name}" error:`, err);
        }
      }, intervalMs);
      handles.set(id, handle);
      return { id, name };
    },

    scheduleOnce(name: string, delayMs: number, task: () => Promise<void>): SchedulerHandle {
      const id = `once-${++counter}`;
      const handle = setTimeout(async () => {
        timeouts.delete(id);
        try {
          await task();
        } catch (err) {
          console.error(`[Scheduler] One-shot "${name}" error:`, err);
        }
      }, delayMs);
      timeouts.set(id, handle);
      return { id, name };
    },

    cancel(handle: SchedulerHandle): void {
      const interval = handles.get(handle.id);
      if (interval) {
        clearInterval(interval);
        handles.delete(handle.id);
      }
      const timeout = timeouts.get(handle.id);
      if (timeout) {
        clearTimeout(timeout);
        timeouts.delete(handle.id);
      }
    },

    list(): Array<{ name: string; handle: SchedulerHandle }> {
      const result: Array<{ name: string; handle: SchedulerHandle }> = [];
      for (const [id, _] of handles) {
        result.push({ name: "recurring", handle: { id, name: "recurring" } });
      }
      for (const [id, _] of timeouts) {
        result.push({ name: "one-shot", handle: { id, name: "one-shot" } });
      }
      return result;
    },

    async shutdown(): Promise<void> {
      for (const [id, handle] of handles) {
        clearInterval(handle);
        handles.delete(id);
      }
      for (const [id, handle] of timeouts) {
        clearTimeout(handle);
        timeouts.delete(id);
      }
    },
  };
}
