// 画面で繰り返し使う小さな部品

import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Card({
	children,
	className = "",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={`rounded-xl border border-line bg-surface px-4 py-3.5 ${className}`}
		>
			{children}
		</div>
	);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: "primary" | "default" | "danger" | "link";
	size?: "md" | "sm";
};

export function buttonClass(
	variant: ButtonProps["variant"] = "default",
	size: ButtonProps["size"] = "md",
) {
	if (variant === "link") {
		return "h-9 px-1.5 text-[13px] font-semibold text-accent disabled:opacity-45";
	}
	const base =
		"inline-flex items-center justify-center gap-2 rounded-[10px] border font-semibold disabled:cursor-not-allowed disabled:opacity-45";
	const sz =
		size === "sm"
			? "h-9 px-3 text-[13px] whitespace-nowrap shrink-0"
			: "h-12 px-5 text-[15px]";
	const color =
		variant === "primary"
			? "border-transparent bg-accent text-white dark:text-accent-ink"
			: variant === "danger"
				? "border-transparent bg-loss text-white"
				: "border-line bg-surface text-text";
	return `${base} ${sz} ${color}`;
}

export function Button({
	variant,
	size,
	className = "",
	type = "button",
	...rest
}: ButtonProps) {
	return (
		<button
			type={type}
			className={`${buttonClass(variant, size)} ${className}`}
			{...rest}
		/>
	);
}

export function ProgressBar({
	value,
	label,
}: {
	value: number;
	label: string;
}) {
	const pct = Math.max(0, Math.min(100, value));
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(pct)}
			className="h-2 overflow-hidden rounded bg-surface-2"
		>
			<div
				className="h-full bg-accent transition-[width]"
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}

/** 選択肢を横に並べる切り替え（ラジオボタン） */
export function Segmented<T extends string>({
	name,
	label,
	options,
	value,
	onChange,
	disabled,
	size = "md",
}: {
	name: string;
	label: string;
	options: readonly (readonly [T, string])[];
	value: T;
	onChange: (v: T) => void;
	disabled?: boolean;
	size?: "md" | "sm";
}) {
	return (
		<fieldset
			disabled={disabled}
			className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-[10px] bg-surface-2 p-[3px] disabled:opacity-60"
		>
			<legend className="sr-only">{label}</legend>
			{options.map(([v, text]) => (
				<label
					key={v}
					className={`flex cursor-pointer items-center justify-center rounded-lg px-1 text-text-2 has-checked:bg-surface has-checked:font-bold has-checked:text-text has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-accent ${size === "sm" ? "h-[30px] text-xs" : "h-9 text-[13px]"}`}
				>
					<input
						type="radio"
						name={name}
						value={v}
						checked={value === v}
						onChange={() => onChange(v)}
						className="sr-only"
					/>
					{text}
				</label>
			))}
		</fieldset>
	);
}

export function Note({
	children,
	tone = "warn",
}: {
	children: ReactNode;
	tone?: "warn" | "plain";
}) {
	return (
		<div
			className={`rounded-[10px] px-3.5 py-3 text-xs leading-relaxed ${tone === "warn" ? "bg-warn" : "border border-dashed border-line text-text-2"}`}
		>
			{children}
		</div>
	);
}
