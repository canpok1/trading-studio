// 1回の実行ごとに Worker を立てて計算させる

import type { BacktestRunner, RunnerOutcome } from "./runner";

export const workerRunner: BacktestRunner = (job) => {
	const shared = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
	const flags = new Int32Array(shared);
	const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
	const outcome = new Promise<RunnerOutcome>((resolve) => {
		worker.onmessage = (e: MessageEvent<RunnerOutcome>) => resolve(e.data);
		worker.onerror = (e) =>
			resolve({
				kind: "failed",
				message: `計算中にエラーが起きた: ${e.message}`,
			});
	}).finally(() => worker.terminate());
	worker.postMessage({ job, shared });
	return {
		progress() {
			const total = Atomics.load(flags, 2);
			return total > 0 ? Atomics.load(flags, 1) / total : 0;
		},
		cancel() {
			Atomics.store(flags, 0, 1);
		},
		outcome,
	};
};
