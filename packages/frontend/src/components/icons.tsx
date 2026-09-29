// アイコン（ナビゲーションはモックと同じ形）

import type { ReactNode } from "react";

type IconProps = { size?: number };

type SvgProps = {
	size: number;
	strokeWidth?: number;
	strokeLinecap?: "round";
	strokeLinejoin?: "round";
	children: ReactNode;
};

// 飾りのアイコン。読み上げは隣の文字で行う
function Svg({ size, strokeWidth = 2, children, ...rest }: SvgProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			aria-hidden="true"
			{...rest}
		>
			{children}
		</svg>
	);
}

export function HomeIcon({ size = 22 }: IconProps) {
	return (
		<Svg size={size} strokeLinejoin="round">
			<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" />
		</Svg>
	);
}

export function BacktestIcon({ size = 22 }: IconProps) {
	return (
		<Svg size={size} strokeLinecap="round" strokeLinejoin="round">
			<path d="M3 12a9 9 0 1 0 3-6.7" />
			<path d="M3 4v5h5" />
			<path d="M12 7v5l3 2" />
		</Svg>
	);
}

export function AiIcon({ size = 22 }: IconProps) {
	return (
		<Svg size={size} strokeLinejoin="round">
			<circle cx="12" cy="12" r="9" />
			<path d="m15.5 8.5-2 5-5 2 2-5z" />
		</Svg>
	);
}

export function StrategyIcon({ size = 22 }: IconProps) {
	return (
		<Svg size={size} strokeLinecap="round">
			<path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
			<circle cx="16" cy="7" r="2" />
			<circle cx="10" cy="17" r="2" />
		</Svg>
	);
}

export function DataIcon({ size = 22 }: IconProps) {
	return (
		<Svg size={size} strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 16V4" />
			<path d="m7 9 5-5 5 5" />
			<path d="M4 16v4h16v-4" />
		</Svg>
	);
}

export function ExportIcon({ size = 22 }: IconProps) {
	return (
		<Svg size={size} strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 4v12" />
			<path d="m7 11 5 5 5-5" />
			<path d="M4 16v4h16v-4" />
		</Svg>
	);
}

export function SettingsIcon({ size = 22 }: IconProps) {
	return (
		<Svg size={size} strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="12" r="3" />
			<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
		</Svg>
	);
}

/** サイドバーの畳む / 広げる。開いているときは左向き、畳んでいるときは右向き */
export function CollapseIcon({
	collapsed,
	size = 18,
}: IconProps & { collapsed: boolean }) {
	return (
		<Svg size={size} strokeLinecap="round" strokeLinejoin="round">
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M9 4v16" />
			<path d={collapsed ? "M13 10l2 2-2 2" : "M16 10l-2 2 2 2"} />
		</Svg>
	);
}

export function OtherIcon({ size = 22 }: IconProps) {
	return (
		<Svg size={size}>
			<rect x="4" y="4" width="6" height="6" rx="1" />
			<rect x="14" y="4" width="6" height="6" rx="1" />
			<rect x="4" y="14" width="6" height="6" rx="1" />
			<rect x="14" y="14" width="6" height="6" rx="1" />
		</Svg>
	);
}

/** ペーパー（模擬売買）の印 */
export function PaperIcon({ size = 16 }: IconProps) {
	return (
		<Svg size={size} strokeLinecap="round" strokeLinejoin="round">
			<path d="M6 3h9l4 4v14H6z" />
			<path d="M14 3v5h5" />
			<path d="M9 13h7M9 17h5" />
		</Svg>
	);
}

export function EmptyIcon({ size = 40 }: IconProps) {
	return (
		<Svg size={size} strokeWidth={1.5} strokeLinecap="round">
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M3 9h18M8 14h8" />
		</Svg>
	);
}

export function ErrorIcon({ size = 40 }: IconProps) {
	return (
		<Svg size={size} strokeWidth={1.5} strokeLinecap="round">
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v6M12 16.5v.5" />
		</Svg>
	);
}

export function HelpIcon({ size = 16 }: IconProps) {
	return (
		<Svg size={size} strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="12" r="9.5" />
			<path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
			<circle cx="12" cy="17" r="0.6" fill="currentColor" />
		</Svg>
	);
}
