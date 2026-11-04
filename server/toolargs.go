package main

import (
	"encoding/json"
	"strings"
)

// 模型在工具参数（尤其 present_quiz）里写 LaTeX 时，常把 `\frac`、`\cdot` 的反斜杠只写一个。
// 这在 JSON 字符串里要么是非法转义（`\c`、`\p`、`\s`…，整段解析失败），要么被当成控制字符
// （`\t`imes、`\f`rac、`\b`egin、`\r`ho、`\n`eq…，公式悄悄损坏）。这里只在 JSON 字符串内部
// 把这类反斜杠补成 `\\`，合法的 `\\`、`\"`、`\/`、`\uXXXX` 以及普通换行等保持不变。

// `\n` 后接这些 LaTeX 命令名（且命令名后不是字母）时按 LaTeX 处理；其他 `\n` 视为换行。
var latexAfterN = []string{"nabla", "neq", "ne", "neg", "nu", "notin", "not", "ni", "nmid", "nleq", "ngeq", "nless", "ngtr", "nsubseteq", "nsupseteq", "newline", "nolimits", "nparallel", "nexists"}

func isLetter(b byte) bool { return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') }
func isHex(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

// latexEscape reports whether the backslash at s[i] starts a LaTeX command rather than a JSON escape.
func latexEscape(s string, i int) bool {
	if i+1 >= len(s) {
		return false
	}
	next := s[i+1]
	switch next {
	case '\\', '"', '/':
		return false
	case 'u':
		if i+5 < len(s) && isHex(s[i+2]) && isHex(s[i+3]) && isHex(s[i+4]) && isHex(s[i+5]) {
			return false
		}
		return true // `\underline`、`\uparrow`
	case 'b', 'f', 'r', 't':
		// 退格、换页、回车、制表符后紧跟字母在题目文本里几乎不会出现，按 LaTeX 命令处理。
		return i+2 < len(s) && isLetter(s[i+2])
	case 'n':
		rest := s[i+1:]
		for _, name := range latexAfterN {
			if strings.HasPrefix(rest, name) && (len(rest) == len(name) || !isLetter(rest[len(name)])) {
				return true
			}
		}
		return false
	default:
		return true // 非法 JSON 转义：`\cdot`、`\pmatrix`、`\sqrt`、`\alpha`、`\{`…
	}
}

// repairLatexEscapes doubles LaTeX backslashes that appear inside JSON string literals.
func repairLatexEscapes(raw string) string {
	var out strings.Builder
	out.Grow(len(raw) + 16)
	inString := false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if !inString {
			if c == '"' {
				inString = true
			}
			out.WriteByte(c)
			continue
		}
		switch c {
		case '"':
			inString = false
			out.WriteByte(c)
		case '\\':
			if latexEscape(raw, i) {
				out.WriteString(`\\`)
				continue
			}
			// 合法转义：原样写出反斜杠和被转义字符，避免把 `\"` 误判为字符串结束。
			out.WriteByte(c)
			if i+1 < len(raw) {
				i++
				out.WriteByte(raw[i])
			}
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

// parseToolArguments parses a tool call's JSON object, repairing LaTeX backslashes first.
func parseToolArguments(raw string) (map[string]any, bool) {
	var args map[string]any
	if json.Unmarshal([]byte(repairLatexEscapes(raw)), &args) == nil && args != nil {
		return args, true
	}
	args = nil
	if json.Unmarshal([]byte(raw), &args) == nil && args != nil {
		return args, true
	}
	return nil, false
}
