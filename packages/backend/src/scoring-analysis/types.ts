// 市場評価の精度（ニュース画面の精度分析）の型。app.ts から参照されるため、Bun 固有の型を持ち込まない（docs/news-page.md）

/** 精度を測る、採点時刻からの長さ */
export const ACCURACY_HORIZONS = ["4h", "24h"] as const;
export type AccuracyHorizon = (typeof ACCURACY_HORIZONS)[number];

/** 精度の設定。設定画面の「ニュース」区分の「精度」で変える */
export type AccuracySettings = {
	/** 集計する期間（日）。新しさの時刻で測る */
	days: number;
	/** 精度に使う、採点時刻からの長さ。精度の内訳の既定にもする */
	horizon: AccuracyHorizon;
	/** 対象がこれ未満なら偶然と区別できないとして「データ不足」を添える */
	minSamples: number;
	/** センチメントと比べる値動きの段階の境目（%）。測る長さごと */
	sentimentBands: Record<AccuracyHorizon, SentimentBands>;
	/** リスクと比べる値動きの段階の境目（%）。測る長さごと */
	riskBands: Record<AccuracyHorizon, RiskBands>;
};

/**
 * 値動きの大きさ（上下は問わない）を3段階に分ける境目（%）。
 * rough 未満が静か、rough 以上 wild 未満が荒れた、wild 以上が大荒れ
 */
export type RiskBands = { rough: number; wild: number };

/**
 * 値動きを5段階に分ける境目（%、上下とも同じ幅）。
 * small 未満が横ばい、small 以上 large 未満が上昇・下落、large 以上が大きく上昇・大きく下落
 */
export type SentimentBands = { small: number; large: number };

export const DEFAULT_ACCURACY_SETTINGS: AccuracySettings = {
	days: 30,
	horizon: "24h",
	minSamples: 30,
	sentimentBands: {
		"4h": { small: 0.2, large: 0.7 },
		"24h": { small: 0.5, large: 2 },
	},
	riskBands: {
		"4h": { rough: 0.7, wild: 1.1 },
		"24h": { rough: 2, wild: 3 },
	},
};

/** 集計する期間の上限（日）。足をメモリに載せるため */
export const ACCURACY_DAYS_MAX = 92;
/** データ不足とする件数の上限 */
export const ACCURACY_MIN_SAMPLES_MAX = 1000;
/** 値動きの段階の境目の上限（%） */
export const ACCURACY_BAND_MAX = 50;

export type SetAccuracySettingsResult =
	| { ok: true }
	| { ok: false; message: string; field: keyof AccuracySettings };

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

/**
 * 評価の段階と値動きの段階の突き合わせ。記事ごとに、段階が一致で2点・1段ずれで1点・それ以外は0点
 */
export type LevelMatch = {
	/** 値動きの段階ごとの件数と点数の合計。段階の低い順で、記事の無い段階も含む */
	levels: { level: number; count: number; points: number }[];
	/** 2点・1点・0点の件数 */
	exact: number;
	near: number;
	miss: number;
	/**
	 * 得点率（%）。値動きの段階ごとの平均点（2点満点に対する割合）を、記事のある段階で平均する。
	 * 中立ばかりで点を稼げないよう、件数で重み付けしない。記事が無ければ null
	 */
	rate: number | null;
};

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
		/** 点数が付き値動きが分かる記事の、評価と値動きの段階の突き合わせ */
		match: LevelMatch;
	};
	risk: {
		scored: number;
		nulls: number;
		/** 最も多い点数とその件数。点数が付いた記事が無ければ null */
		mode: { score: number; count: number } | null;
		/** 点数が付き値動きが分かる記事の、評価と値動きの段階の突き合わせ */
		match: LevelMatch;
	};
};

export type VersionAccuracy = VersionStats & {
	/** センチメントが0点（値動きの段階と2段以上ずれた）だったもの */
	misses: AccuracyList;
	/** 中立の帯で 0 でないもの（平均を薄める弱い点数） */
	neutral: AccuracyList;
	/** リスクの段階が、その後の値動きの段階より低かったもの（平常なのに荒れたなど） */
	missedRisk: AccuracyList;
	/** リスクの段階が、その後の値動きの段階より高かったもの（危機なのに静かなど） */
	falseAlarm: AccuracyList;
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
	/** リスクと比べる値動きの段階の境目 */
	riskBands: RiskBands;
	/** センチメントと比べる値動きの段階の境目 */
	sentimentBands: SentimentBands;
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
	/** horizon を省くと設定の長さで測る */
	accuracy(horizon?: AccuracyHorizon): AccuracyReport;
	accuracySettings(): AccuracySettings;
	setAccuracySettings(s: AccuracySettings): SetAccuracySettingsResult;
}
