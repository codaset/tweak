// How long the worker waits before its next try at the bridge while awake:
// 1, 2, 5 seconds, then every 10 (the same steps as tweak watch). While it
// sleeps, the 30-second alarm wakes it instead.
const STEPS = [1000, 2000, 5000, 10000];

export const retryDelay = (attempt) => STEPS[Math.min(attempt, STEPS.length - 1)];
