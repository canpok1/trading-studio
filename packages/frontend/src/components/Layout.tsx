import type { ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useTradingStatus } from "../lib/trading";
import {
	AiIcon,
	BacktestIcon,
	DataIcon,
	ExportIcon,
	HomeIcon,
	OtherIcon,
	PaperIcon,
	SettingsIcon,
	StrategyIcon,
	TradesIcon,
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
	{ to: "/trades", label: "取引", icon: <TradesIcon />, show: "both" },
	{ to: "/ai", label: "AI判定", icon: <AiIcon />, show: "side" },
	{ to: "/data", label: "過去データ", icon: <DataIcon />, show: "side" },
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
		also: ["/settings", "/data", "/export", "/ai"],
	},
];

/** 画面の枠。スマホは下部タブ、PC（1024px 以上）は左サイドバー */
export function Layout({ badges = {} }: { badges?: Record<string, boolean> }) {
	const { pathname } = useLocation();
	return (
		<div className="flex min-h-full flex-col lg:flex-row">
			<nav
				aria-label="メイン"
				className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[220px] lg:shrink-0 lg:flex-col lg:gap-0.5 lg:border-t-0 lg:border-r lg:px-3 lg:py-5"
			>
				<div className="hidden px-2.5 pb-4 text-[15px] font-bold lg:block">
					trading-studio
				</div>
				{NAV.map((item) => {
					const extra = item.also?.some((p) => pathname.startsWith(p)) ?? false;
					return (
						<NavLink
							key={item.to}
							to={item.to}
							className={({ isActive }) => {
								const active = isActive || extra;
								return [
									"relative flex h-16 flex-col items-center justify-center gap-0.5 text-[11px]",
									"lg:h-[42px] lg:flex-row lg:justify-start lg:gap-2.5 lg:rounded-lg lg:px-2.5 lg:text-sm",
									item.show === "tab" ? "lg:hidden" : "",
									item.show === "side" ? "hidden lg:flex" : "",
									active
										? "font-bold text-accent lg:bg-surface-2 lg:text-text"
										: "text-text-2 lg:text-text",
								].join(" ");
							}}
						>
							{item.icon}
							{item.label}
							{badges[item.to] && (
								<span
									data-testid={`badge-${item.to}`}
									className="absolute top-2.5 right-[calc(50%-18px)] h-2 w-2 rounded-full bg-accent lg:static lg:ml-auto"
								>
									<span className="sr-only">（実行中）</span>
								</span>
							)}
						</NavLink>
					);
				})}
			</nav>
			<main className="min-w-0 flex-1 pb-[calc(88px+env(safe-area-inset-bottom))] lg:pb-8">
				<TradingBand />
				<Outlet />
			</main>
		</div>
	);
}

/** 自動取引がオンの間だけ、全画面の上部に出す帯 */
function TradingBand() {
	const { status } = useTradingStatus();
	if (!status?.enabled) return null;
	return (
		<aside
			aria-label="稼働中の自動取引"
			className="sticky top-0 z-30 flex min-h-10 items-center gap-2 border-b-[3px] border-dashed border-paper-ink bg-paper px-4 text-xs text-paper-ink"
		>
			<PaperIcon />
			<strong className="text-[13px] whitespace-nowrap">ペーパー稼働中</strong>
			<span className="hidden sm:inline">最新の実データで模擬売買</span>
			<span
				data-testid="band-strategy"
				className="ml-auto min-w-0 truncate font-bold"
			>
				{status.strategy?.name ?? ""}
			</span>
		</aside>
	);
}
