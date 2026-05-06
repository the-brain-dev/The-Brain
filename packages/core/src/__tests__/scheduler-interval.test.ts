/**
 * Interval Scheduler — tests
 */
import { describe, it, expect, afterEach } from "bun:test";
import { createIntervalScheduler } from "../scheduler-interval";

describe("IntervalScheduler", () => {
  let scheduler = createIntervalScheduler();

  afterEach(async () => {
    await scheduler.shutdown();
    scheduler = createIntervalScheduler();
  });

  it("schedule returns a handle", () => {
    const handle = scheduler.schedule("test-recurring", 10000, async () => {});
    expect(handle.id).toMatch(/^sched-/);
    expect(handle.name).toBe("test-recurring");
  });

  it("scheduleOnce returns a handle", () => {
    const handle = scheduler.scheduleOnce("test-once", 500, async () => {});
    expect(handle.id).toMatch(/^once-/);
    expect(handle.name).toBe("test-once");
  });

  it("lists scheduled tasks", () => {
    scheduler.schedule("r1", 5000, async () => {});
    scheduler.scheduleOnce("o1", 100, async () => {});

    const tasks = scheduler.list();
    expect(tasks.length).toBe(2);
    expect(tasks.some(t => t.name === "recurring")).toBe(true);
    expect(tasks.some(t => t.name === "one-shot")).toBe(true);
  });

  it("executes recurring task", async () => {
    let calls = 0;
    const handle = scheduler.schedule("count", 20, async () => { calls++; });

    await new Promise(r => setTimeout(r, 70));
    expect(calls).toBeGreaterThanOrEqual(2);
    scheduler.cancel(handle);
  });

  it("executes one-shot task", async () => {
    let called = false;
    scheduler.scheduleOnce("fire", 20, async () => { called = true; });

    await new Promise(r => setTimeout(r, 60));
    expect(called).toBe(true);
  });

  it("cancel stops recurring task", async () => {
    let calls = 0;
    const handle = scheduler.schedule("cancellable", 20, async () => { calls++; });

    await new Promise(r => setTimeout(r, 40)); // let it fire 1-2 times
    scheduler.cancel(handle);
    const afterCancel = calls;

    await new Promise(r => setTimeout(r, 50));
    expect(calls).toBe(afterCancel);
  });

  it("cancel is no-op for unknown handle", () => {
    scheduler.cancel({ id: "does-not-exist", name: "nope" });
    // should not throw
  });

  it("shutdown clears all tasks", async () => {
    scheduler.schedule("s1", 5000, async () => {});
    scheduler.scheduleOnce("s2", 100, async () => {});

    await scheduler.shutdown();
    const tasks = scheduler.list();
    expect(tasks.length).toBe(0);
  });

  it("handles errors in task gracefully", async () => {
    let errorCaught = false;
    const origError = console.error;
    console.error = (..._args: any[]) => { errorCaught = true; };

    scheduler.schedule("failing", 20, async () => { throw new Error("planned"); });

    await new Promise(r => setTimeout(r, 60));
    console.error = origError;
    expect(errorCaught).toBe(true);
  });

  it("scheduleOnce cleans up after execution", async () => {
    scheduler.scheduleOnce("cleanup", 10, async () => {});
    await new Promise(r => setTimeout(r, 50));

    const tasks = scheduler.list();
    expect(tasks.length).toBe(0); // one-shot removed after completion
  });
});
