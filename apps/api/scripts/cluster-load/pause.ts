const STEP_MS = 250;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function pauseChecking(ms: number, check: () => void): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    check();
    await sleep(Math.min(STEP_MS, until - Date.now()));
  }
  check();
}
