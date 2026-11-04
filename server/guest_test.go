package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGuestConfigIsOptIn(t *testing.T) {
	t.Setenv("APP_ENV", "internal")
	t.Setenv("APP_BIND", "")
	t.Setenv("APP_ACCESS_TOKEN", "")
	t.Setenv("APP_ALLOW_GUEST", "")
	if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "APP_ACCESS_TOKEN") {
		t.Fatalf("internal access token must be required: %v", err)
	}
	t.Setenv("APP_ALLOW_GUEST", "1")
	cfg, err := loadConfig()
	if err != nil || !cfg.allowGuest {
		t.Fatalf("guest mode must work without an access token: %v", err)
	}
	t.Setenv("APP_BIND", "0.0.0.0:18085")
	if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("guest mode must require a loopback bind: %v", err)
	}
}

func TestGuestSessionModelAndOrigin(t *testing.T) {
	db, err := openStore(filepath.Join(t.TempDir(), "app.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.db.Close()
	s, router := newServer(config{
		allowGuest: true, apiKey: "server-test-key", userID: "developer", model: "deepseek-flash",
		dailyBudget: 100_000, maxOutput: 512, maxInput: 64_000, timeout: 2 * time.Second,
	}, db)
	mock(t, s, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer server-test-key" {
			t.Error("missing server key in upstream request")
		}
		writeCompletion(w)
	})

	sessionReq := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	sessionReq.AddCookie(&http.Cookie{Name: cookieName, Value: "expired-internal-session"})
	session := httptest.NewRecorder()
	router.ServeHTTP(session, sessionReq)
	var payload struct {
		Mode       string
		User       struct{ ID string }
		ModelReady bool
	}
	if err := json.Unmarshal(session.Body.Bytes(), &payload); err != nil || session.Code != 200 ||
		payload.Mode != "guest" || payload.User.ID != guestUserID || !payload.ModelReady ||
		len(session.Result().Cookies()) != 0 || strings.Contains(session.Body.String(), s.cfg.apiKey) {
		t.Fatalf("invalid guest session: status=%d body=%s", session.Code, session.Body.String())
	}

	login := httptest.NewRecorder()
	router.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/internal/session", strings.NewReader(`{"accessToken":""}`)))
	if login.Code != http.StatusNotFound || len(login.Result().Cookies()) != 0 {
		t.Fatalf("guest login returned status %d or set a cookie", login.Code)
	}

	body, err := json.Marshal(request("guest-model"))
	if err != nil {
		t.Fatal(err)
	}
	send := func(origin, ip string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "https://chat.example/api/model", bytes.NewReader(body))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("Origin", origin)
		req.Header.Set("X-Forwarded-For", ip)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	crossSite := send("https://untrusted.example", "198.51.100.1")
	if crossSite.Code != http.StatusForbidden {
		t.Fatalf("cross-site request returned %d", crossSite.Code)
	}
	s.users.Store("guest/198.51.100.1", true)
	if busy := send("https://chat.example", "203.0.113.1, 198.51.100.1"); busy.Code != http.StatusTooManyRequests {
		t.Fatalf("same client request returned %d", busy.Code)
	}
	ok := send("https://chat.example", "198.51.100.2")
	result, err := io.ReadAll(ok.Result().Body)
	if err != nil || ok.Code != http.StatusOK || !strings.Contains(string(result), "你好") {
		t.Fatalf("independent guest could not chat: status=%d body=%s error=%v", ok.Code, result, err)
	}
	var userID string
	if err := db.db.QueryRow("SELECT user_id FROM usage WHERE request_id=?", "guest-model").Scan(&userID); err != nil || userID != guestUserID {
		t.Fatalf("unexpected usage user %q: %v", userID, err)
	}
}
