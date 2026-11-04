package main

import "testing"

func TestParseToolArgumentsRepairsLatexBackslashes(t *testing.T) {
	cases := []struct {
		name, raw, field, want string
	}{
		// 非法转义：未修复前 json.Unmarshal 直接失败。
		{"invalid escapes", `{"question":"计算 $A\cdot B$，其中 $A=\pmatrix{1&2}$"}`, "question", `计算 $A\cdot B$，其中 $A=\pmatrix{1&2}$`},
		// 合法但含义错误的转义：未修复前 \t、\f、\b、\r 会变成控制字符。
		{"control escapes", `{"text":"$\times$ $\frac{1}{2}$ $\begin{pmatrix}0\end{pmatrix}$ $\rho$"}`, "text", `$\times$ $\frac{1}{2}$ $\begin{pmatrix}0\end{pmatrix}$ $\rho$`},
		{"latex after n", `{"text":"$a\neq b$，$\nabla f$"}`, "text", `$a\neq b$，$\nabla f$`},
		// 已正确转义的内容、普通换行、引号与 Unicode 转义保持原意。
		{"already escaped", `{"text":"$\\frac{1}{2}$\\\\ ok"}`, "text", `$\frac{1}{2}$\\ ok`},
		{"plain newline and quote", `{"text":"第一行\n第二行 \"引号\" 中"}`, "text", "第一行\n第二行 \"引号\" 中"},
		{"underline is latex, unicode is not", `{"text":"$\underline{x}$ A"}`, "text", `$\underline{x}$ A`},
	}
	for _, c := range cases {
		args, ok := parseToolArguments(c.raw)
		if !ok {
			t.Fatalf("%s: parse failed for %s", c.name, c.raw)
		}
		if got, _ := args[c.field].(string); got != c.want {
			t.Fatalf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	if _, ok := parseToolArguments(`{"question":`); ok {
		t.Fatal("truncated JSON must still be rejected")
	}
	if _, ok := parseToolArguments(`["not","object"]`); ok {
		t.Fatal("non-object JSON must still be rejected")
	}
}
