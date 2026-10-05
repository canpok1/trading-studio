// 市場評価の当たり具合（ニュース画面のカード）の型。app.ts から参照されるため、Bun 固有の型を持ち込まない（docs/news-page.md）

/** 当たり具合を測る、採点時刻からの長さ */
export const ACCURACY_HORIZONS = ["4h", "24h"] as const;
export type AccuracyHorizon = (typeof ACCURACY_HORIZONS)[number];

/** 当たり具合を集計する期間（日）。新しさの時刻で測る */
export const ACCURACY_DAYS = 30;

/** 当たりの件数がこれ未満なら偶然と区別できないと出す */
export const ACCURACY_MIN_SAMPLES = 30;

/** 記事の一覧に出す上限（新しい順） */
export const ACCURACY_LIST_MAX = 30;

/** 一覧に出す記事。点数はその版のもの */
export type AccuracyNews = {
	id: number;
	title: string;
	url: string;
	sourceName: string;
	publishedAt: number;
	sentiment: number | null;
	risk: number | null;
	comment: string | null;
	/** 採点時刻から測る長さの後の騰落率（%）。価格が無ければ null */
	returnPct: number | null;
};

/** 記事の一覧。total は上限で切る前の件数 */
export type AccuracyList = { total: number; items: AccuracyNews[] };

/** ある版の採点を、ある記事の集まりで集計したもの */
export type VersionStats = {
	version: number;
	/** この版で採点した記事の件数 */
	articles: number;
	sentiment: {
		/** 点数が付いた件数（関係なしを除く） */
		scored: number;
		/** 関係なし（null）の件数 */
		nulls: number;
		/** プラスの件数 */
		positive: number;
		/** 中立の帯（やや弱気の上限〜やや強気の下限の手前）で 0 でない件数 */
		neutralBand: number;
		/** 強気材料・弱気材料（やや強気以上・やや弱気以下）で、値動きが分かり 0 でない件数 */
		directed: number;
		/** そのうち点数の符号と値動きの向きが合った件数 */
		hits: number;
	};
	risk: {
		scored: number;
		nulls: number;
		/** 最も多い点数とその件数。点数が付いた記事が無ければ null */
		mode: { score: number; count: number } | null;
		/** 警戒以上の点数で、値動きが分かる件数 */
		high: number;
		/** 警戒以上の記事の後の値動きの大きさの平均（%）。無ければ null */
		highMeanAbsPct: number | null;
		/** この版の値動きが分かるすべての記事の後の値動きの大きさの平均（%）。無ければ null */
		baseMeanAbsPct: number | null;
	};
};

export type VersionAccuracy = VersionStats & {
	/** 強気材料・弱気材料で、値動きの向きが点数と逆だったもの */
	misses: AccuracyList;
	/** 中立の帯で 0 でないもの（平均を薄める弱い点数） */
	neutral: AccuracyList;
	/** 警戒以上なのに、その後の値動きがこの版の平均より小さかったもの */
	calmRisk: AccuracyList;
};

/** 同じ記事どうしで、使用中の版とほかの版を比べたもの */
export type VersionComparison = {
	/** 比べる版 */
	version: number;
	/** 両方の版で採点した記事の件数 */
	common: number;
	other: VersionStats;
	active: VersionStats;
};

export type AccuracyReport = {
	from: number;
	to: number;
	horizon: AccuracyHorizon;
	/** 集計した期間（日） */
	days: number;
	/** 当たりの件数がこれ未満なら偶然と区別できない */
	minSamples: number;
	/** 値動きに使った足の粒度。足が無ければ null */
	priceTimeframe: string | null;
	/** 使用中の版。版が無ければ null */
	activeVersion: number | null;
	/** 評価が戦略の判断を変えうる状態だった時間 */
	influence: {
		/** 評価のある時間（採点の記録が始まった後） */
		judgedHours: number;
		/** センチメントが中立以外の時間 */
		sentiment: number;
		/** リスクが平常以外の時間 */
		risk: number;
	};
	/** 期間内に採点のある版。新しい順。使用中の版は運用の採点とほかの版から採点し直したものを合わせる */
	versions: VersionAccuracy[];
	/** 使用中の版とほかの版の、同じ記事どうしの比較。新しい版から */
	comparisons: VersionComparison[];
};

export interface AccuracyService {
	accuracy(horizon: AccuracyHorizon): AccuracyReport;
}
