import { useEffect, useState } from "react";

/**
 * 数値の入力欄。入力中の文字はそのまま持ち、読める数値になったら onChange で渡す（読めなければ NaN）。
 * 外から値が変わったら表示を合わせる
 */
export function NumberInput({
	value,
	onChange,
	format = (n) => String(n),
	parse = (s) => (s.trim() === "" ? Number.NaN : Number(s.replace(/,/g, ""))),
	invalid,
	className = "",
	...rest
}: {
	value: number;
	onChange: (n: number) => void;
	format?: (n: number) => string;
	parse?: (s: string) => number;
	invalid?: boolean;
	className?: string;
	"aria-label"?: string;
	id?: string;
	inputMode?: "numeric" | "decimal";
}) {
	const [text, setText] = useState(() =>
		Number.isFinite(value) ? format(value) : "",
	);
	useEffect(() => {
		setText((cur) => {
			const same =
				Object.is(parse(cur), value) ||
				(Number.isNaN(value) && Number.isNaN(parse(cur)));
			return same ? cur : Number.isFinite(value) ? format(value) : "";
		});
	}, [value, format, parse]);
	return (
		<input
			type="text"
			inputMode={rest.inputMode ?? "decimal"}
			value={text}
			aria-invalid={invalid || undefined}
			onChange={(e) => {
				setText(e.target.value);
				onChange(parse(e.target.value));
			}}
			className={`num h-9 rounded-lg border border-line bg-surface px-2 text-center text-sm aria-invalid:border-2 aria-invalid:border-loss ${className}`}
			{...rest}
		/>
	);
}
