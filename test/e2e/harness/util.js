// Waiting and process helpers shared by the harness.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether a process, or with a negative ID a process group, still has a
// live member.
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Polls fn until `is` accepts its value (by default, a truthy one), and
// resolves with that value. An error counts as not yet. On timeout it
// rejects, naming `what` it waited for and the last value or error it saw.
export async function until(fn, { timeout = 10_000, every = 50, what = "a condition", is = Boolean } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (is(value)) return value;
      last = { value };
    } catch (error) {
      last = { error };
    }
    if (Date.now() > end) {
      const seen = last.error ? `last error: ${last.error.message ?? last.error}` : `last value: ${JSON.stringify(last.value)}`;
      throw new Error(`timed out after ${timeout / 1000} s waiting for ${what}; ${seen}`);
    }
    await sleep(every);
  }
}
