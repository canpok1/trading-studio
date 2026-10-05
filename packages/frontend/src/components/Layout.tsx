import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { formatSignedInt, formatSignedPercent } from "../lib/number";
import { useTradingStatus } from "../lib/trading";
import { AppVersion } from "./AppVersion";
import {
	AiIcon,
	BacktestIcon,
	CollapseIcon,
	DataIcon,
	ExportIcon,
	HomeIcon,
	OtherIcon,
	PaperIcon,
	SettingsIcon,
	StrategyIcon,
} from "./icons";

type NavItem = {
	to: string;
	label: string;
	icon: ReactNode;
	/** tab: スマホの下部タブだけ、side: PC のサイドバーだけ、both: 両方 */
	show: "tab" | "side" | "both";
	/** このパスの下にいるときも選択中にする */
	also?: string[];
};

const NAV: NavItem[] = [
	{ to: "/home", label: "ホーム", icon: <HomeIcon />, show: "both" },
	{
		to: "/backtest",
		label: "バックテスト",
		icon: <BacktestIcon />,
		show: "both",
	},
	{
		to: "/strategies",
		label: "戦略",
		icon: <StrategyIcon />,
		show: "both",
	},
	{ to: "/news", label: "ニュース", icon: <AiIcon />, show: "both" },
	{ to: "/data", label: "インポート", icon: <DataIcon />, show: "side" },
	{
		to: "/export",
		label: "エクスポート",
		icon: <ExportIcon />,
		show: "side",
	},
	{ to: "/settings", label: "設定", icon: <SettingsIcon />, show: "side" },
	{
		to: "/other",
		label: "その他",
		icon: <OtherIcon />,
		show: "tab",
		also: ["/settings", "/data", "/export"],
	},
];

const COLLAPSED_KEY = "side-collapsed";

function readCollapsed(): boolean {
	try {
		return localStorage.getItem(COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}

/** PC のサイドバーを畳んでいるか。ブラウザに保存し、次に開いたときも保つ */
function useSideCollapsed(): [boolean, () => void] {
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const toggle = useCallback(() => {
		setCollapsed((c) => {
			try {
				if (c) localStorage.removeItem(COLLAPSED_KEY);
				else localStorage.setItem(COLLAPSED_KEY, "1");
			} catch {
				// 保存できない環境（プライベートモードなど）では、この画面を開いている間だけ効く
			}
			return !c;
		});
	}, []);
	return [collapsed, toggle];
}

/** 画面の枠。スマホは下部タブ、PC（1024px 以上）は左サイドバー（アイコンだけに畳める） */
export function Layout({ badges = {} }: { badges?: Record<string, boolean> }) {
	const { pathname } = useLocation();
	const [collapsed, toggleCollapsed] = useSideCollapsed();
	return (
		<div className="flex min-h-full flex-col lg:flex-row">
			<nav
				aria-label="メイン"
				className={[
					"fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-brand bg-brand text-brand-ink-2 pb-[env(safe-area-inset-bottom)] lg:sticky lg:top-0 lg:flex lg:h-screen lg:shrink-0 lg:flex-col lg:gap-0.5 lg:border-t-0 lg:py-5",
					collapsed ? "lg:w-16 lg:px-2" : "lg:w-[220px] lg:px-3",
				].join(" ")}
			>
				<div
					className={[
						"hidden items-center pb-4 lg:flex",
						collapsed ? "justify-center" : "justify-between pl-2.5",
					].join(" ")}
				>
					{!collapsed && (
						<span className="text-[15px] font-bold text-brand-ink">
							trading-studio
						</span>
					)}
					<button
						type="button"
						onClick={toggleCollapsed}
						aria-expanded={!collapsed}
						aria-label={
							collapsed ? "サイドメニューを広げる" : "サイドメニューを畳む"
						}
						title={collapsed ? "広げる" : "畳む"}
						className="flex h-8 w-8 items-center justify-center rounded-lg text-brand-ink-2 hover:bg-white/10 hover:text-brand-ink"
					>
						<CollapseIcon collapsed={collapsed} />
					</button>
				</div>
				{NAV.map((item) => {
					const extra = item.also?.some((p) => pathname.startsWith(p)) ?? false;
					return (
						<NavLink
							key={item.to}
							to={item.to}
							title={collapsed ? item.label : undefined}
							className={({ isActive }) => {
								const active = isActive || extra;
								return [
									"relative flex h-16 flex-col items-center justify-center gap-0.5 text-[11px]",
									"lg:h-[42px] lg:flex-row lg:rounded-lg lg:text-sm",
									collapsed
										? "lg:justify-center lg:px-0"
										: "lg:justify-start lg:gap-2.5 lg:px-2.5",
									item.show === "tab" ? "lg:hidden" : "",
									item.show === "side" ? "hidden lg:flex" : "",
									// スマホは選択中のタブの上端に線、PC は行を塗る
									active
										? "font-bold text-brand-ink before:absolute before:inset-x-[30%] before:top-0 before:h-[3px] before:rounded-b before:bg-brand-ink lg:bg-white/15 lg:before:hidden"
										: "text-brand-ink-2 lg:hover:bg-white/10 lg:hover:text-brand-ink",
								].join(" ");
							}}
						>
							{item.icon}
							<span className={collapsed ? "lg:sr-only" : ""}>
								{item.label}
							</span>
							{badges[item.to] && (
								<span
									data-testid={`badge-${item.to}`}
									className={[
										"absolute top-2.5 right-[calc(50%-18px)] h-2 w-2 rounded-full bg-brand-ink",
										collapsed ? "lg:top-2 lg:right-2" : "lg:static lg:ml-auto",
									].join(" ")}
								>
									<span className="sr-only">（実行中）</span>
								</span>
							)}
						</NavLink>
					);
				})}
				{!collapsed && (
					<AppVersion className="mt-auto hidden px-2.5 lg:block" />
				)}
			</nav>
			<main className="min-w-0 flex-1 pb-[calc(88px+env(safe-area-inset-bottom))] lg:pb-8">
				<TradingBand />
				<Outlet />
			</main>
		</div>
	);
}

/**
 * 自動取引がオンの間だけ、全画面の上部に出す帯。通算損益を出し、押すとホームの稼働中のタブへ。
 * 複数のタブが稼働中なら件数と、損益の合計（開始時の資金の合計に対する %）を出す
 */
function TradingBand() {
	const { runs } = useTradingStatus();
	const running = runs?.filter((r) => r.enabled) ?? [];
	const first = running[0];
	if (!first) return null;
	const initialCash = running.reduce((n, r) => n + r.account.initialCash, 0);
	const pnl = running.every((r) => r.account.equity !== null)
		? running.reduce(
				(n, r) => n + (r.account.equity ?? 0) - r.account.initialCash,
				0,
			)
		: null;
	return (
		<aside
			aria-label="稼働中の自動取引"
			className="sticky top-0 z-30 border-b-[3px] border-dashed border-paper-ink bg-paper text-xs text-paper-ink"
		>
			<Link
				to={`/home?run=${first.id}`}
				className="flex min-h-10 items-center gap-2 px-4"
			>
				<PaperIcon />
				<strong className="text-[13px] whitespace-nowrap">
					{running.length > 1 ? `デモ ${running.length}件稼働中` : "デモ稼働中"}
				</strong>
				<span className="hidden xl:inline">最新の実データで模擬売買</span>
				<span
					data-testid="band-pnl"
					className="num font-bold whitespace-nowrap"
				>
					<span className="sr-only">通算損益 </span>
					{pnl === null
						? "損益 —"
						: `${formatSignedInt(pnl)}円（${formatSignedPercent((pnl / initialCash) * 100)}）`}
				</span>
				<span
					data-testid="band-strategy"
					className="ml-auto min-w-0 truncate font-bold"
				>
					{running.length > 1
						? running.map((r) => r.name).join("・")
						: (first.strategy?.name ?? "")}
				</span>
			</Link>
		</aside>
	);
}
