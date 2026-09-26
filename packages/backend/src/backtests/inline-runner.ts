// テスト用に同じスレッドで計算する。gate を渡すと、それが解決するまで計算を始めない（実行中の状態を試すため）

import { execute } from "./execute";
import type { BacktestRunner } from "./runner";

export function inlineRunner(gate?: () => Promise<void>): BacktestRunner {
	return (job) => {
		let canceled = false;
		let progress = 0;
		const outcome = (async () => {
			await (gate ? gate() : Promise.resolve());
			return execute(
				job,
				(done, total) => {
					progress = done / total;
				},
				() => canceled,
			);
		})();
		return {
			progress: () => progress,
			cancel() {
				canceled = true;
			},
			outcome,
		};
	};
}
