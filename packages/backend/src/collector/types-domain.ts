// 価格収集の型。app.ts から参照されるため、Bun 固有の型を持ち込まない

/** connecting: 接続中（起動直後・再接続中） / running: 動作中 / stopped: 停止中（再接続を待っている） */
export type CollectorState = "connecting" | "running" | "stopped";

export type CollectorStatus = {
	state: CollectorState;
	/** 最後に約定を漏れなく受けられていた時刻。止まっていなければ null */
	stoppedSince: number | null;
	/** 止まった理由。止まっていなければ null */
	error: string | null;
	/** 次に再接続する時刻。予定が無ければ null */
	retryAt: number | null;
	/** 最後に取引所から何かを受け取った時刻 */
	lastReceivedAt: number | null;
};
