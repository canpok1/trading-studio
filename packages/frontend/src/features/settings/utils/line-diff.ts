// 採点の基準の版の差分。行ごとに最長共通部分列で比べる

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	const n = a.length;
	const m = b.length;
	// lcs[i][j] は a[i..] と b[j..] の最長共通部分列の長さ
	const lcs = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			const row = lcs[i] as number[];
			row[j] =
				a[i] === b[j]
					? ((lcs[i + 1] as number[])[j + 1] as number) + 1
					: Math.max(
							(lcs[i + 1] as number[])[j] as number,
							row[j + 1] as number,
						);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] as string });
			i++;
			j++;
		} else if (
			((lcs[i + 1] as number[])[j] as number) >=
			((lcs[i] as number[])[j + 1] as number)
		) {
			out.push({ kind: "del", text: a[i++] as string });
		} else {
			out.push({ kind: "add", text: b[j++] as string });
		}
	}
	while (i < n) out.push({ kind: "del", text: a[i++] as string });
	while (j < m) out.push({ kind: "add", text: b[j++] as string });
	return out;
}
