package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

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
		{"display math", `{"text":"$$\frac{1}{2}\neq 0$$"}`, "text", `$$\frac{1}{2}\neq 0$$`},
		{"TeX inline delimiters", `{"text":"\(\frac{1}{2}\)"}`, "text", `\(\frac{1}{2}\)`},
		{"escaped TeX display delimiters", `{"text":"\\[\rho+\nu\\]"}`, "text", `\[\rho+\nu\]`},
		{"mixed prose and formula", `{"question":"代码：\n\tprint(1)，公式：$\frac{1}{2}$"}`, "question", "代码：\n\tprint(1)，公式：$\\frac{1}{2}$"},
		{"quoted formula", `{"text":"\"$\frac{1}{2}$\""}`, "text", `"$\frac{1}{2}$"`},
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

func TestParseToolArgumentsPreservesNonMathJSON(t *testing.T) {
	cases := []struct{ name, raw string }{
		{"search query with TSV", `{"query":"alpha\tbeta"}`},
		{"quiz with code indentation", `{"question":"执行下面代码：\n\tprint(1)"}`},
		{"learning progress with CR", `{"progress":"alpha\rbeta"}`},
		{"ordinary control escapes", `{"text":"a\bb\fc\rd\te\nf"}`},
		{"newline resembles command", `{"text":"line 1\neq\nabla\nu"}`},
		{"inline code containing dollars", `{"question":"代码 ` + "`" + `$x\tbeta$` + "`" + `"}`},
		{"fenced code containing math", `{"question":"` + "```python" + `\n$x\tbeta$\n` + "```" + `"}`},
		{"tilde code fence", `{"question":"~~~python\n$x\tbeta$\n~~~"}`},
		{"unmatched currency dollar", `{"text":"$5\tpaid"}`},
		{"escaped dollar", `{"text":"cost \\$5\tpaid"}`},
		{"math state cannot leak across fields", `{"question":"$x$","query":"alpha\tbeta","options":[{"text":"x\ry"}]}`},
		{"intentional Unicode control in math", `{"text":"$x\u0009beta$"}`},
		{"escaped math commands in code", `{"text":"` + "`" + `$\\frac{1}{2}$` + "`" + `"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var previous map[string]any
			if err := json.Unmarshal([]byte(tc.raw), &previous); err != nil {
				t.Fatal(err)
			}
			current, ok := parseToolArguments(tc.raw)
			if !ok || !reflect.DeepEqual(current, previous) {
				t.Fatalf("valid JSON changed: input=%s, previous=%#v, current=%#v", tc.raw, previous, current)
			}
		})
	}
}
