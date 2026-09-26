// 価格収集の型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type { Candle, MarketTrade } from "@trading-studio/core";

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

export type LiveMarket = {
	/** 直近の約定。まだ無ければ null */
	latestTrade: MarketTrade | null;
	/** 形成中の1分足。価格が分からなければ null */
	forming: Candle | null;
	/** 分は終わったが、確定の猶予の間でまだ保存していない1分足（古い順） */
	unsaved: Candle[];
	status: CollectorStatus;
};

export type FeedHandlers = {
	/** 購読が始まった（この後に届く約定は漏れなく届く） */
	onReady(): void;
	onTrades(trades: MarketTrade[]): void;
	/** 約定以外も含め、何かを受け取った。接続が生きている印に使う */
	onMessage(): void;
	onClose(reason: string): void;
};

/** 取引所から約定を受ける手段。テストと E2E では偽物に差し替える */
export interface TradeFeed {
	connect(handlers: FeedHandlers): { close(): void };
	/** 直近の約定（遡れる範囲だけ）。新しい順とは限らない */
	recentTrades(): Promise<MarketTrade[]>;
}
