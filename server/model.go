package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gin-gonic/gin"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,128}$`)
var allowedTools = map[string]bool{"present_quiz": true, "read_skill": true, "update_learning_state": true, "search_context": true, "cite_sources": true}

func validID(s string) bool { return idPattern.MatchString(s) }

type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}
type wireMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}
type wireTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}
type modelRequest struct {
	ContractVersion string        `json:"contractVersion"`
	RequestID       string        `json:"requestId"`
	TurnID          string        `json:"turnId"`
	SessionID       string        `json:"sessionId"`
	Messages        []wireMessage `json:"messages"`
	Tools           []wireTool    `json:"tools"`
}

func validateRequest(v modelRequest) error {
	if v.ContractVersion != contractVersion || !validID(v.RequestID) || !validID(v.TurnID) || !validID(v.SessionID) || len(v.Messages) < 2 || len(v.Messages) > 64 || len(v.Tools) > len(allowedTools) {
		return fmt.Errorf("invalid envelope")
	}
	declared := map[string]bool{}
	for _, t := range v.Tools {
		if t.Type != "function" || !allowedTools[t.Function.Name] || declared[t.Function.Name] || len(t.Function.Parameters) > 12000 {
			return fmt.Errorf("unknown tool")
		}
		var schema map[string]any
		if json.Unmarshal(t.Function.Parameters, &schema) != nil || schema["type"] != "object" {
			return fmt.Errorf("invalid schema")
		}
		declared[t.Function.Name] = true
	}
	pending := map[string]bool{}
	seen := map[string]bool{}
	for i, m := range v.Messages {
		if len(pending) > 0 && m.Role != "tool" {
			return fmt.Errorf("unresolved tool results")
		}
		switch m.Role {
		case "system":
			if i != 0 || m.Content == "" {
				return fmt.Errorf("invalid system message")
			}
		case "user":
			if strings.TrimSpace(m.Content) == "" {
				return fmt.Errorf("empty user")
			}
		case "assistant":
			if m.Content == "" && len(m.ToolCalls) == 0 {
				return fmt.Errorf("empty assistant")
			}
			for _, t := range m.ToolCalls {
				// Historical calls remain valid when a tool is disabled after failure or user preference.
				if !allowedTools[t.Function.Name] || !validID(t.ID) || seen[t.ID] || t.Type != "function" || !json.Valid([]byte(t.Function.Arguments)) {
					return fmt.Errorf("invalid tool call")
				}
				pending[t.ID] = true
				seen[t.ID] = true
			}
		case "tool":
			if !pending[m.ToolCallID] {
				return fmt.Errorf("orphan tool result")
			}
			delete(pending, m.ToolCallID)
		default:
			return fmt.Errorf("invalid role")
		}
		if m.Role != "assistant" && len(m.ToolCalls) > 0 || m.Role != "tool" && m.ToolCallID != "" {
			return fmt.Errorf("unexpected tool fields")
		}
	}
	if v.Messages[0].Role != "system" || len(pending) > 0 {
		return fmt.Errorf("invalid conversation")
	}
	last := v.Messages[len(v.Messages)-1].Role
	if last != "user" && last != "tool" {
		return fmt.Errorf("invalid last message")
	}
	return nil
}

type providerChunk struct {
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		Input  int64 `json:"prompt_tokens"`
		Output int64 `json:"completion_tokens"`
		Total  int64 `json:"total_tokens"`
	} `json:"usage"`
	Error json.RawMessage `json:"error"`
}

func (s *appServer) model(c *gin.Context) {
	if !s.modelReady() {
		fail(c, 503, "MODEL_NOT_CONFIGURED", "请先在服务器环境文件中配置真实 DeepSeek API 密钥")
		return
	}
	var v modelRequest
	if decode(c, &v) != nil || validateRequest(v) != nil {
		fail(c, 400, "INVALID_REQUEST", "模型请求不符合 app.v1 契约")
		return
	}
	payload := map[string]any{"model": s.cfg.model, "messages": v.Messages, "stream": true, "stream_options": map[string]bool{"include_usage": true}, "max_tokens": s.cfg.maxOutput, "thinking": map[string]string{"type": "disabled"}}
	if len(v.Tools) > 0 {
		payload["tools"] = v.Tools
		payload["tool_choice"] = "auto"
	}
	body, e := json.Marshal(payload)
	if e != nil || len(body) > s.cfg.maxInput {
		fail(c, 413, "CONTEXT_TOO_LARGE", "本轮上下文过长，请新建对话或缩小资料范围")
		return
	}
	user := c.GetString("userID")
	if _, loaded := s.users.LoadOrStore(user, true); loaded {
		fail(c, 429, "CONCURRENCY_LIMIT", "上一请求仍在结束，请稍后重试")
		return
	}
	defer s.users.Delete(user)
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		fail(c, 429, "CONCURRENCY_LIMIT", "服务并发已达上限")
		return
	}
	// Conservative UTF-8 byte bound plus protocol overhead, not a client-supplied token estimate.
	reserved := int64(len(body) + 4096 + s.cfg.maxOutput)
	if e = s.store.reserve(v.RequestID, user, budgetDay(time.Now()), reserved, s.cfg.dailyBudget); e != nil {
		switch {
		case errors.Is(e, errBudget):
			fail(c, 429, "BUDGET_EXCEEDED", "今日全局 token 预算不足（包含正在进行请求的预留额度）")
		case errors.Is(e, errDuplicate):
			fail(c, 409, "DUPLICATE_REQUEST", "此请求已处理，请勿重复提交")
		default:
			fail(c, 503, "STORAGE_FAILED", "无法预留用量，未发起模型请求")
		}
		return
	}
	inputTokens, outputTokens := int64(-1), int64(-1)
	status := "unknown"
	started := time.Now()
	defer func() {
		if e := s.store.settle(v.RequestID, inputTokens, outputTokens, status); e != nil {
			log.Printf("usage settlement failed request=%s", v.RequestID)
		}
		log.Printf("model request=%s status=%s duration_ms=%d input=%d output=%d", v.RequestID, status, time.Since(started).Milliseconds(), inputTokens, outputTokens)
	}()
	ctx, cancel := context.WithTimeout(c.Request.Context(), s.cfg.timeout)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(body))
	if e != nil {
		inputTokens = 0
		outputTokens = 0
		status = "not_sent"
		fail(c, 500, "MODEL_CONFIG", "模型配置无效")
		return
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	response, e := s.client.Do(req)
	if e != nil {
		status = "upstream_error"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			fail(c, 504, "MODEL_TIMEOUT", "模型响应超时，请手动重试")
		} else {
			fail(c, 502, "MODEL_UNAVAILABLE", "无法连接模型服务，请稍后重试")
		}
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		status = "upstream_http"
		code, message := "MODEL_UNAVAILABLE", "模型服务暂不可用，请稍后重试"
		if response.StatusCode == 401 || response.StatusCode == 403 {
			code = "MODEL_AUTH_FAILED"
			message = "模型服务认证失败，请检查服务器 API 密钥"
		}
		if response.StatusCode == 402 {
			code = "MODEL_BALANCE"
			message = "模型账号余额不足"
		}
		if response.StatusCode == 429 {
			code = "MODEL_RATE_LIMIT"
			message = "模型服务限流，请稍后重试"
		}
		// No completion on an explicit rejection; unknown 5xx may have incurred usage.
		if response.StatusCode >= 400 && response.StatusCode < 500 {
			inputTokens = 0
			outputTokens = 0
		}
		fail(c, 502, code, message)
		return
	}
	c.Header("Content-Type", "text/event-stream; charset=utf-8")
	c.Header("X-Accel-Buffering", "no")
	c.Status(200)
	send := func(event any) bool {
		if ctx.Err() != nil {
			return false
		}
		b, _ := json.Marshal(event)
		_, e := fmt.Fprintf(c.Writer, "data: %s\n\n", b)
		if e != nil {
			return false
		}
		c.Writer.Flush()
		return true
	}
	protocolError := func(code, msg string) {
		status = code
		send(map[string]any{"type": "error", "code": code, "message": msg})
	}
	if !send(map[string]any{"type": "start", "requestId": v.RequestID}) {
		status = "cancelled"
		return
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 262144)
	calls := map[int]*toolCall{}
	finish := ""
	done := false
	totalBytes := 0
	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}
		line := scanner.Text()
		totalBytes += len(line)
		if totalBytes > 2*1024*1024 {
			protocolError("MODEL_PROTOCOL", "模型响应超出大小限制")
			return
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		raw := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if raw == "[DONE]" {
			done = true
			break
		}
		var chunk providerChunk
		if json.Unmarshal([]byte(raw), &chunk) != nil || len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			protocolError("MODEL_PROTOCOL", "模型返回了无效流数据")
			return
		}
		if chunk.Usage != nil {
			u := chunk.Usage
			if u.Input < 0 || u.Output < 0 || u.Total != u.Input+u.Output {
				protocolError("MODEL_PROTOCOL", "模型用量数据无效")
				return
			}
			inputTokens = u.Input
			outputTokens = u.Output
		}
		for _, choice := range chunk.Choices {
			if choice.Index != 0 || finish != "" {
				protocolError("MODEL_PROTOCOL", "模型终态顺序不正确")
				return
			}
			if choice.Delta.Content != "" && !send(map[string]any{"type": "text_delta", "delta": choice.Delta.Content}) {
				status = "cancelled"
				return
			}
			for _, part := range choice.Delta.ToolCalls {
				if len(v.Tools) == 0 || part.Index < 0 || part.Index >= 6 {
					protocolError("MODEL_PROTOCOL", "模型返回了不允许的工具调用")
					return
				}
				call := calls[part.Index]
				if call == nil {
					call = &toolCall{Type: "function"}
					calls[part.Index] = call
				}
				if part.ID != "" {
					if call.ID != "" && call.ID != part.ID {
						protocolError("MODEL_PROTOCOL", "工具 ID 不一致")
						return
					}
					call.ID = part.ID
				}
				call.Function.Name += part.Function.Name
				call.Function.Arguments += part.Function.Arguments
				if len(call.Function.Arguments) > 65536 {
					protocolError("MODEL_PROTOCOL", "工具参数过长")
					return
				}
			}
			if choice.FinishReason != nil {
				finish = *choice.FinishReason
			}
		}
	}
	if ctx.Err() != nil {
		status = "cancelled"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			status = "MODEL_TIMEOUT"
		}
		return
	}
	if scanner.Err() != nil || !done || finish == "" {
		protocolError("MODEL_STREAM_INTERRUPTED", "模型连接提前关闭，请手动重试")
		return
	}
	if inputTokens < 0 {
		protocolError("MODEL_USAGE_MISSING", "模型未返回用量，本次保留预留额度，请检查服务")
		return
	}
	if finish != "stop" && finish != "tool_calls" && finish != "length" {
		protocolError("MODEL_PROTOCOL", "模型返回了未知结束原因")
		return
	}
	if finish == "tool_calls" {
		if len(calls) == 0 {
			protocolError("MODEL_PROTOCOL", "缺少工具调用")
			return
		}
		validated := []map[string]any{}
		ids := map[string]bool{}
		for index := 0; index < len(calls); index++ {
			call := calls[index]
			declared := false
			if call != nil {
				for _, tool := range v.Tools {
					if tool.Function.Name == call.Function.Name {
						declared = true
					}
				}
			}
			if call == nil || !validID(call.ID) || ids[call.ID] || !declared || !allowedTools[call.Function.Name] {
				protocolError("MODEL_PROTOCOL", "工具调用不完整或不在白名单")
				return
			}
			ids[call.ID] = true
			var args map[string]any
			if json.Unmarshal([]byte(call.Function.Arguments), &args) != nil || args == nil {
				protocolError("MODEL_PROTOCOL", "工具参数不是完整 JSON 对象")
				return
			}
			validated = append(validated, map[string]any{"type": "tool_call", "id": call.ID, "name": call.Function.Name, "arguments": args})
		}
		for _, event := range validated {
			if !send(event) {
				status = "cancelled"
				return
			}
		}
	} else if len(calls) > 0 && finish != "length" {
		protocolError("MODEL_PROTOCOL", "工具调用缺少正确终态")
		return
	}
	if !send(map[string]any{"type": "usage", "usage": map[string]int64{"input": inputTokens, "output": outputTokens, "total": inputTokens + outputTokens}}) {
		status = "cancelled"
		return
	}
	reason := "stop"
	if finish == "tool_calls" {
		reason = "toolUse"
	} else if finish == "length" {
		reason = "length"
	}
	status = "completed"
	if !send(map[string]any{"type": "finish", "stopReason": reason}) {
		status = "cancelled"
	}
}
