// 戦略のインターフェース。戦略は純関数で、現在時刻・乱数・外部アクセスを使わない。
// 状態は変数に持たず、入出力の state で受け渡す（再起動やバックテストで結果が変わらないようにするため）

import type { Timeframe } from "./timeframe";
import type {
	Candle,
	JsonValue,
	Judgment,
	Order,
	OrderIntent,
	Position,
} from "./types";

export type StrategyInput<P> = {
	/** 評価時刻。この時刻までに確定した足だけが candles に入る */
	now: number;
	/** 戦略の粒度の確定済みの足（古い順） */
	candles: readonly Candle[];
	/** 判定器ごとの、その時点で得られていた AI 判定 */
	judgments: Readonly<Record<string, readonly Judgment[]>>;
	position: Position;
	/** 使える現金（円） */
	cash: number;
	/** 未約定の注文 */
	openOrders: readonly Order[];
	params: P;
	/** 前回の出力の state。初回は null */
	state: JsonValue;
};

export type StrategyOutput = {
	intents: OrderIntent[];
	/** 次に評価してほしい時刻 */
	nextEvalAt: number;
	state: JsonValue;
	/** 判断理由（判断ログとチャートのアイコンで見せる） */
	note?: string;
};

export type ValidationError = { path: string; message: string };

export type Strategy<P> = {
	id: string;
	/** 使う判定器の名前。フェーズ1では空 */
	requiredJudges(params: P): string[];
	/** 戦略が必要とする足の粒度。データがこれより粗ければ実行できない */
	minResolution(params: P): Timeframe;
	/** パラメータの入力検証。問題が無ければ空配列 */
	validate(params: P): ValidationError[];
	evaluate(input: StrategyInput<P>): StrategyOutput;
};
