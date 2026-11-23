import { errorTag } from "./log-safe.ts";

// One post-sync step failing must not skip the steps after it: the error is logged by tag only,
// the step's name goes in `failed` (so the run still answers 500), and the step counts as `fallback`.
export async function runStep<T>(name: string, failed: string[], run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`post-sync step ${name} failed: ${errorTag(err)}`);
    failed.push(name);
    return fallback;
  }
}
