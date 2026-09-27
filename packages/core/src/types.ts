// 全モード（バックテスト・ペーパー・ライブ）で共通の取引の型。
// 金額は円の整数、数量は satoshi の整数、時刻は UTC のエポックミリ秒（.claude/rules/values.md）

/** 足。time は足の開始時刻 */
export type Candle = {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	/** 出来高（satoshi） */
	volume: number;
};

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";

/** 売りを出した条件のグループ。利確（takeProfit）か損切り（stopLoss）か */
export type ExitKind = "takeProfit" | "stopLoss";

/** 戦略が出す注文の意図。発注・取消は呼び出し側（エンジン・取引所への橋渡し）が行う */
export type OrderIntent =
	| {
			kind: "place";
			side: Side;
			type: OrderType;
			/** 指値の価格。成行では持たない */
			price?: number;
			quantity: number;
			/** この本数（戦略の粒度の足）のあいだ約定しなければ取り消す。未指定なら取り消さない */
			expireAfterBars?: number;
			/** 売りで、どのロットを売るか（ロットの id）。売りでは必須 */
			lotId?: string;
			/** 売りで、どちらの条件のグループで売るか */
			exitKind?: ExitKind;
	  }
	| { kind: "cancel"; orderId: string; reason?: string };

export type OrderStatus = "open" | "filled" | "canceled";

export type Order = {
	id: string;
	side: Side;
	type: OrderType;
	/** 指値の価格。成行は null */
	price: number | null;
	quantity: number;
	placedAt: number;
	/** この時刻までに約定しなければ取り消す。null は期限なし */
	expiresAt: number | null;
	status: OrderStatus;
	/** 売りが売るロットの id。買いでは持たない */
	lotId?: string | null;
};

/** 約定。手数料は円 */
export type Fill = {
	orderId: string;
	side: Side;
	time: number;
	price: number;
	quantity: number;
	fee: number;
};

/** 保有の合計（全ロット）。quantity が 0 ならポジションなし */
export type Position = {
	quantity: number;
	/** 約定価格の平均（手数料を含めない）。ポジションなしなら null */
	entryPrice: number | null;
	/** 最初のロットの買いが約定した時刻。ポジションなしなら null */
	openedAt: number | null;
};

/** ロット。約定した買い注文1件ぶんの保有。売りはロットごとに判定し、ロット全量を売る */
export type Lot = {
	/** 買い注文の id */
	id: string;
	quantity: number;
	/** 買いの約定価格（手数料を含めない） */
	entryPrice: number;
	/** 買いが約定した時刻 */
	openedAt: number;
};

export const EMPTY_POSITION: Position = {
	quantity: 0,
	entryPrice: null,
	openedAt: null,
};

/** AI 判定（フェーズ3で使う）。judge は判定器の名前 */
export type Judgment = {
	judge: string;
	time: number;
	label: string;
};

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
