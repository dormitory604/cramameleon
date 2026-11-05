package main

import (
	"encoding/json"
	"strings"
)

// 模型在工具参数（尤其 present_quiz）里写 LaTeX 时，常把 `\frac`、`\cdot` 的反斜杠只写一个。
// 这在 JSON 字符串里要么是非法转义（`\c`、`\p`、`\s`…，整段解析失败），要么被当成控制字符
// （`\t`imes、`\f`rac、`\b`egin、`\r`ho、`\n`eq…，公式悄悄损坏）。只修复明确数学片段里的
// 反斜杠，普通文本、Markdown 代码及合法的 `\\`、`\"`、`\/`、`\uXXXX` 保持不变。

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
		// 仅在数学片段里消除控制字符与 LaTeX 命令的歧义。
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

// mathDelimiter recognizes both malformed and correctly JSON-escaped TeX delimiters.
func mathDelimiter(raw string, i int) (string, int) {
	if raw[i] == '$' {
		if i+1 < len(raw) && raw[i+1] == '$' {
			return "$$", 2
		}
		return "$", 1
	}
	if raw[i] == '\\' && i+1 < len(raw) {
		width := 1
		if raw[i+1] == '\\' {
			width++
		}
		if i+width < len(raw) && strings.ContainsRune("()[]", rune(raw[i+width])) {
			return "\\" + raw[i+width:i+width+1], width + 1
		}
	}
	return "", 0
}

// repairLatexEscapes only repairs closed math spans outside Markdown code. Work in
// raw JSON so an intentional Unicode escape or doubled backslash stays untouched.
func repairLatexEscapes(raw string) string {
	out := make([]byte, 0, len(raw)+16)
	inString := false
	mathEnd := ""
	mathStart, mathOutputStart := 0, 0
	var codeMarker byte
	codeWidth := 0
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if !inString {
			if c == '"' {
				inString = true
				mathEnd, codeMarker, codeWidth = "", 0, 0
			}
			out = append(out, c)
			continue
		}
		if mathEnd == "" && (c == '`' || c == '~') {
			end := i + 1
			for end < len(raw) && raw[end] == c {
				end++
			}
			width := end - i
			if codeWidth == 0 && (c == '`' || width >= 3) {
				codeMarker, codeWidth = c, width
			} else if c == codeMarker && (width == codeWidth || c == '~' && width >= codeWidth) {
				codeWidth = 0
			}
			out = append(out, raw[i:end]...)
			i = end - 1
			continue
		}
		if codeWidth == 0 {
			marker, width := mathDelimiter(raw, i)
			if marker != "" {
				handled := false
				if mathEnd == "" {
					switch marker {
					case "$", "$$":
						mathEnd = marker
					case `\(`:
						mathEnd = `\)`
					case `\[`:
						mathEnd = `\]`
					}
					if mathEnd != "" {
						mathStart, mathOutputStart = i, len(out)
						handled = true
					}
				} else if marker == mathEnd {
					mathEnd = ""
					handled = true
				}
				if handled {
					if marker[0] == '\\' {
						out = append(out, '\\')
					}
					out = append(out, marker...)
					i += width - 1
					continue
				}
			}
		}
		switch c {
		case '"':
			// An unmatched dollar can be a currency symbol, not a math opener.
			if mathEnd != "" {
				out = append(out[:mathOutputStart], raw[mathStart:i]...)
			}
			inString = false
			out = append(out, c)
		case '\\':
			if mathEnd != "" && latexEscape(raw, i) {
				out = append(out, '\\', '\\')
				continue
			}
			// 合法转义：原样写出反斜杠和被转义字符，避免把 `\"` 误判为字符串结束。
			out = append(out, c)
			if i+1 < len(raw) {
				i++
				out = append(out, raw[i])
				// A JSON-escaped Markdown backslash protects the following marker.
				if raw[i] == '\\' && i+1 < len(raw) && (raw[i+1] == '$' || raw[i+1] == '`') {
					i++
					out = append(out, raw[i])
				}
			}
		default:
			out = append(out, c)
		}
	}
	return string(out)
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

// Stream only complete items from the first field of {"quizzes":[...]}.
// The outer object may still be incomplete. Final tool arguments are checked
// separately, using the same LaTeX repair.
const maxQuizBatch = 6

func quizBatchPrefix(raw string) []map[string]any {
	decoder := json.NewDecoder(strings.NewReader(repairLatexEscapes(raw)))
	for _, want := range []json.Token{json.Delim('{'), "quizzes", json.Delim('[')} {
		got, err := decoder.Token()
		if err != nil || got != want {
			return nil
		}
	}
	var items []map[string]any
	for len(items) < maxQuizBatch && decoder.More() {
		var item map[string]any
		if decoder.Decode(&item) != nil || item == nil {
			break
		}
		items = append(items, item)
	}
	return items
}
