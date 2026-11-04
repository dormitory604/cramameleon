package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setup(t *testing.T) (*appServer, *httptest.Server, *http.Client) {
	t.Helper()
	db, e := openStore(filepath.Join(t.TempDir(), "app.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.db.Close() })
	cfg := config{staticDir: t.TempDir(), apiKey: "test-key", model: "deepseek-flash", accessToken: "test-internal-access-token-123456", userID: "developer", dailyBudget: 100000, maxOutput: 512, maxInput: 64000, timeout: 2 * time.Second}
	s, r := newServer(cfg, db)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	return s, srv, client
}
func login(t *testing.T, srv *httptest.Server, client *http.Client) {
	t.Helper()
	r, e := client.Post(srv.URL+"/api/internal/session", "application/json", strings.NewReader(`{"accessToken":"test-internal-access-token-123456"}`))
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("login %d", r.StatusCode)
	}
}
func request(id string) modelRequest {
	return modelRequest{ContractVersion: contractVersion, RequestID: id, SessionID: "chat-1", TurnID: "turn-1", Messages: []wireMessage{{Role: "system", Content: "You are helpful."}, {Role: "user", Content: "hello"}}}
}
func post(t *testing.T, srv *httptest.Server, client *http.Client, v modelRequest) (int, string) {
	t.Helper()
	b, _ := json.Marshal(v)
	r, e := client.Post(srv.URL+"/api/model", "application/json", bytes.NewReader(b))
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	body, _ := io.ReadAll(r.Body)
	return r.StatusCode, string(body)
}
func mock(t *testing.T, s *appServer, fn http.HandlerFunc) {
	t.Helper()
	p := httptest.NewServer(fn)
	t.Cleanup(p.Close)
	s.endpoint = p.URL
}
func writeCompletion(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,\"total_tokens\":13}}\n\ndata: [DONE]\n\n")
}

func TestDailyTokenBudgetConfig(t *testing.T) {
	t.Setenv("APP_ENV", "internal")
	t.Setenv("APP_BIND", "")
	t.Setenv("APP_ACCESS_TOKEN", "test-internal-access-token-123456")
	t.Setenv("APP_MAX_INPUT_BYTES", "")
	t.Setenv("APP_MAX_OUTPUT_TOKENS", "")
	t.Setenv("APP_DEVELOPER_ID", "")
	t.Setenv("DEEPSEEK_MODEL", "")
	for _, tt := range []struct {
		name, value string
		want        int64
	}{
		{name: "default", want: 1_000_000},
		{name: "environment override", value: "200000", want: 200_000},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("APP_DAILY_TOKEN_BUDGET", tt.value)
			cfg, err := loadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if cfg.dailyBudget != tt.want {
				t.Errorf("daily budget = %d, want %d", cfg.dailyBudget, tt.want)
			}
		})
	}
}

func TestAuthorizationAndNoDemo(t *testing.T) {
	_, srv, client := setup(t)
	code, _ := post(t, srv, client, request("unauth"))
	if code != 401 {
		t.Fatal(code)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/internal/session", strings.NewReader("{}"))
	req.Header.Set("Origin", "https://untrusted.example")
	r, e := client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatal(r.StatusCode)
	}
	login(t, srv, client)
	r, e = client.Post(srv.URL+"/api/demo/session", "application/json", strings.NewReader("{}"))
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 404 {
		t.Fatal("demo route remains")
	}
	r, e = client.Post(srv.URL+"/api/logout", "application/json", nil)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	code, _ = post(t, srv, client, request("after-logout"))
	if code != 401 {
		t.Fatal(code)
	}
}
func TestForwardingSettlementAndDuplicate(t *testing.T) {
	s, srv, c := setup(t)
	login(t, srv, c)
	calls := 0
	mock(t, s, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing key")
		}
		var v map[string]any
		if json.NewDecoder(r.Body).Decode(&v) != nil {
			t.Error("invalid JSON")
		}
		if v["model"] != "deepseek-flash" || v["stream"] != true || v["max_tokens"] != float64(512) {
			t.Error("server limits not forwarded")
		}
		messages := v["messages"].([]any)
		if len(messages) != 2 || messages[1].(map[string]any)["content"] != "hello" {
			t.Error("content lost")
		}
		writeCompletion(w)
	})
	code, body := post(t, srv, c, request("r1"))
	if code != 200 || !strings.Contains(body, `"delta":"你好"`) || !strings.Contains(body, `"stopReason":"stop"`) {
		t.Fatal(code, body)
	}
	used, e := s.store.used(budgetDay(time.Now()))
	if e != nil || used != 13 {
		t.Fatal(used, e)
	}
	code, _ = post(t, srv, c, request("r1"))
	if code != 409 || calls != 1 {
		t.Fatal("duplicate upstream request", code, calls)
	}
	s.cfg.dailyBudget = 14
	code, _ = post(t, srv, c, request("r2"))
	if code != 429 || calls != 1 {
		t.Fatal("budget not enforced")
	}
}
func TestFragmentedToolCall(t *testing.T) {
	s, srv, c := setup(t)
	login(t, srv, c)
	mock(t, s, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		parts := []any{
			map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call-1", "function": map[string]any{"name": "present_quiz", "arguments": "{\"question\":"}}}}}}},
			map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]any{"arguments": "\"test\"}"}}}}, "finish_reason": "tool_calls"}}},
			map[string]any{"choices": []any{}, "usage": map[string]int{"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}},
		}
		for _, p := range parts {
			b, _ := json.Marshal(p)
			fmt.Fprintf(w, "data: %s\n\n", b)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	v := request("tools")
	var tool wireTool
	_ = json.Unmarshal([]byte(`{"type":"function","function":{"name":"present_quiz","description":"quiz","parameters":{"type":"object"}}}`), &tool)
	v.Tools = []wireTool{tool}
	code, body := post(t, srv, c, v)
	if code != 200 || strings.Count(body, `"type":"tool_call"`) != 1 || !strings.Contains(body, `"arguments":{"question":"test"}`) {
		t.Fatal(code, body)
	}
}
func TestInterruptedStreamKeepsReservation(t *testing.T) {
	s, srv, c := setup(t)
	login(t, srv, c)
	mock(t, s, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n")
	})
	_, body := post(t, srv, c, request("interrupted"))
	if !strings.Contains(body, "MODEL_STREAM_INTERRUPTED") || strings.Contains(body, `"type":"finish"`) {
		t.Fatal(body)
	}
	used, _ := s.store.used(budgetDay(time.Now()))
	if used < 4096 {
		t.Fatal("unknown usage refunded", used)
	}
}
func TestPersistentBudgetAndBeijingDay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	s, e := openStore(path)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.reserve("a", "u", "2026-11-04", 100, 100); e != nil {
		t.Fatal(e)
	}
	s.db.Close()
	s, e = openStore(path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.db.Close()
	if e = s.reserve("b", "u", "2026-11-04", 1, 100); e != errBudget {
		t.Fatal("restart lost reservation", e)
	}
	if e = s.reserve("a", "u", "2026-11-05", 1, 100); e != errDuplicate {
		t.Fatal("duplicate lost", e)
	}
	if e = s.settle("a", 20, 10, "completed"); e != nil {
		t.Fatal(e)
	}
	used, _ := s.used("2026-11-04")
	if used != 30 {
		t.Fatal(used)
	}
	if budgetDay(time.Date(2026, 11, 4, 16, 0, 0, 0, time.UTC)) != "2026-11-05" {
		t.Fatal("wrong timezone")
	}
}
func TestCancellationAndConcurrency(t *testing.T) {
	s, srv, c := setup(t)
	login(t, srv, c)
	started := make(chan struct{})
	cancelled := make(chan struct{})
	mock(t, s, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"start\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(cancelled)
	})
	b, _ := json.Marshal(request("cancel"))
	r, e := c.Post(srv.URL+"/api/model", "application/json", bytes.NewReader(b))
	if e != nil {
		t.Fatal(e)
	}
	<-started
	code, _ := post(t, srv, c, request("concurrent"))
	if code != 429 {
		t.Fatal(code)
	}
	r.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream not cancelled")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, ok := s.users.Load("developer"); !ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("slot leaked")
}
func TestMissingConfigAndInvalidTools(t *testing.T) {
	s, srv, c := setup(t)
	login(t, srv, c)
	s.cfg.apiKey = "replace-me"
	code, body := post(t, srv, c, request("missing"))
	if code != 503 || !strings.Contains(body, "MODEL_NOT_CONFIGURED") {
		t.Fatal(code, body)
	}
	s.cfg.apiKey = "test"
	v := request("invalid")
	v.Messages = append(v.Messages, wireMessage{Role: "tool", ToolCallID: "orphan", Content: "x"})
	code, _ = post(t, srv, c, v)
	if code != 400 {
		t.Fatal(code)
	}
}

func TestTeachingToolDeclarationsAndRetiredHistory(t *testing.T) {
	v := request("teaching")
	var skill wireTool
	_ = json.Unmarshal([]byte(`{"type":"function","function":{"name":"read_skill","description":"skill","parameters":{"type":"object"}}}`), &skill)
	v.Tools = []wireTool{skill}
	if e := validateRequest(v); e != nil {
		t.Fatal(e)
	}
	call := toolCall{ID: "skill-call", Type: "function"}
	call.Function.Name = "read_skill"
	call.Function.Arguments = `{"name":"review"}`
	v.Messages = append(v.Messages, wireMessage{Role: "assistant", ToolCalls: []toolCall{call}}, wireMessage{Role: "tool", ToolCallID: "skill-call", Content: "published skill"})
	v.Tools = nil
	if e := validateRequest(v); e != nil {
		t.Fatal("retired tool history rejected", e)
	}
	v.Tools = []wireTool{skill, skill}
	if validateRequest(v) == nil {
		t.Fatal("duplicate declarations accepted")
	}
	v.Tools[0].Function.Name = "shell"
	if validateRequest(v) == nil {
		t.Fatal("unsafe tool accepted")
	}
}
func TestMultipleTeachingCallsAndUndeclaredTool(t *testing.T) {
	s, srv, c := setup(t)
	login(t, srv, c)
	mock(t, s, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"s1\",\"function\":{\"name\":\"read_skill\",\"arguments\":\"{\\\"name\\\":\\\"review\\\"}\"}},{\"index\":1,\"id\":\"s2\",\"function\":{\"name\":\"update_learning_state\",\"arguments\":\"{\\\"course\\\":\\\"probability\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\ndata: [DONE]\n\n")
	})
	v := request("batch")
	for _, name := range []string{"read_skill", "update_learning_state"} {
		var tool wireTool
		tool.Type = "function"
		tool.Function.Name = name
		tool.Function.Parameters = json.RawMessage(`{"type":"object"}`)
		v.Tools = append(v.Tools, tool)
	}
	_, body := post(t, srv, c, v)
	if strings.Count(body, `"type":"tool_call"`) != 2 {
		t.Fatal(body)
	}
	v.RequestID = "undeclared"
	v.Tools = v.Tools[:1]
	_, body = post(t, srv, c, v)
	if !strings.Contains(body, "MODEL_PROTOCOL") || strings.Contains(body, `"type":"tool_call"`) {
		t.Fatal("partial unsafe batch emitted", body)
	}
}
