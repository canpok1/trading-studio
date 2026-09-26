// バックテストを計算する Worker。API の応答を止めないよう、別スレッドで動かす

import { execute } from "./execute";
import type { RunnerJob } from "./runner";

declare const self: Worker;

self.onmessage = (
	e: MessageEvent<{ job: RunnerJob; shared: SharedArrayBuffer }>,
) => {
	// [0]: 中止の要求 / [1]: 済んだ足の数 / [2]: 全体の足の数
	const flags = new Int32Array(e.data.shared);
	const outcome = execute(
		e.data.job,
		(done, total) => {
			Atomics.store(flags, 1, done);
			Atomics.store(flags, 2, total);
		},
		() => Atomics.load(flags, 0) === 1,
	);
	// gzip の出力は共有のメモリ領域を使うことがあるので、転送せずに複製して渡す
	self.postMessage(outcome);
};
