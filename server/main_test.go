package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func setup(t *testing.T) (*demoServer, *httptest.Server, *http.Client) {
	t.Helper()
	t.Setenv("APP_ENV", "demo")
	t.Setenv("APP_DEMO_AUTH_ENABLED", "true")
	s, router := newServer(config{staticDir: t.TempDir(), delay: time.Millisecond})
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	return s, server, client
}
func login(t *testing.T, server *httptest.Server, client *http.Client) {
	t.Helper()
	response, err := client.Post(server.URL+"/api/demo/session", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("login: %d", response.StatusCode)
	}
}
func payload(scenario, role string) []byte {
	data, _ := json.Marshal(map[string]any{"contractVersion": "demo.v1", "requestId": "request-test", "turnId": "turn-test", "scenario": scenario, "messages": []map[string]string{{"role": role}}})
	return data
}
func TestAuthorizationAndCSRF(t *testing.T) {
	_, server, client := setup(t)
	response, err := client.Post(server.URL+"/api/model", "application/json", bytes.NewReader(payload("chat", "user")))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatalf("unauth: %d", response.StatusCode)
	}
	request, _ := http.NewRequest("POST", server.URL+"/api/demo/session", strings.NewReader("{}"))
	request.Header.Set("Origin", "https://untrusted.example")
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatalf("origin: %d", response.StatusCode)
	}
	login(t, server, client)
	response, err = client.Get(server.URL + "/api/session")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("session: %d", response.StatusCode)
	}
}
func TestModelToolRoundTrip(t *testing.T) {
	s, server, client := setup(t)
	login(t, server, client)
	for index, role := range []string{"user", "toolResult"} {
		response, err := client.Post(server.URL+"/api/model", "application/json", bytes.NewReader(payload("quiz", role)))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			t.Fatalf("invalid stream: %d", response.StatusCode)
		}
		if index == 0 && !strings.Contains(string(body), `"type":"tool_call"`) {
			t.Fatal("missing tool call")
		}
		if index == 1 && strings.Contains(string(body), `"type":"tool_call"`) {
			t.Fatal("backend incorrectly executed another agent turn")
		}
		if !strings.Contains(string(body), `"type":"finish"`) {
			t.Fatal("missing terminal event")
		}
	}
	if s.requests.Load() != 2 || s.completed.Load() != 2 || s.active.Load() != 0 {
		t.Fatal("incorrect request lifecycle counts")
	}
}
func TestStreamCancellationAndInvalidScenario(t *testing.T) {
	s, server, client := setup(t)
	login(t, server, client)
	response, err := client.Post(server.URL+"/api/model", "application/json", bytes.NewReader(payload("unknown", "user")))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatal("unknown scenario accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	request, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/model", bytes.NewReader(payload("slow", "toolResult")))
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 64)
	_, _ = response.Body.Read(buffer)
	cancel()
	response.Body.Close()
	deadline := time.Now().Add(time.Second)
	for s.active.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if s.active.Load() != 0 || s.cancelled.Load() != 1 {
		t.Fatal("cancelled stream did not release resources")
	}
}
