package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMaterialAdapterCredentialBindingAndNoRedirects(t *testing.T) {
	f := oldAuth(t)
	f.callback(t, f.start(t, ""))
	_, session := f.session(t)
	user := session["user"].(map[string]any)["id"].(string)
	var calls int
	var requestID string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("credential", 5) {
			t.Error("missing user credential")
		}
		switch r.URL.Path {
		case "/api/integrations/cramameleon/materials":
			json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "total": 0})
		case "/api/integrations/cramameleon/materials/1/access":
			var v struct {
				RequestID string `json:"requestId"`
			}
			_ = json.NewDecoder(r.Body).Decode(&v)
			requestID = v.RequestID
			json.NewEncoder(w).Encode(map[string]any{"readId": "fixture", "charged": 1})
		case "/api/integrations/cramameleon/materials/2":
			http.Redirect(w, r, "https://example.invalid/secret", 302)
		case "/api/integrations/cramameleon/materials/3":
			w.WriteHeader(401)
		default:
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	// The fixture identity must still match the configured upstream issuer.
	f.s.cfg.oldSite.issuer = upstream.URL
	_, _ = f.s.store.db.Exec("UPDATE app_users SET issuer=?", upstream.URL)
	call := func(method, path, body, identity string) *http.Response {
		req, _ := http.NewRequest(method, f.app.URL+"/api/old-site"+path, strings.NewReader(body))
		req.Header.Set("Origin", f.s.cfg.oldSite.publicURL)
		req.Header.Set("X-Cram-User", identity)
		r, err := f.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		return r
	}
	if r := call("GET", "/materials", "", user); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if r := call("GET", "/materials", "", "other-user"); r.StatusCode != 409 {
		t.Fatal("switched user fetched materials")
	}
	if calls != 1 {
		t.Fatal("identity failure reached upstream")
	}
	for _, path := range []string{"/materials?url=https://evil.example", "/materials?token=secret", "/materials/1/preview", "/packages/1/items/1/access"} {
		if r := call("GET", path, "", user); r.StatusCode < 400 {
			t.Fatal("unsupported proxy path accepted", path)
		}
	}
	if r := call("POST", "/materials/1/access", `{"requestId":"same-request-id-0001"}`, user); r.StatusCode != 200 || requestID != "same-request-id-0001" {
		t.Fatal("idempotency key not forwarded")
	}
	if r := call("GET", "/materials/2", "", user); r.StatusCode != 502 {
		t.Fatal("upstream redirect accepted")
	}
	if r := call("GET", "/materials/3", "", user); r.StatusCode != 401 {
		t.Fatal("expired credential accepted")
	}
	before := calls
	if r := call("GET", "/quota", "", user); r.StatusCode != 401 || calls != before {
		t.Fatal("expired credential reused")
	}
	if status, _ := f.session(t); status != 200 {
		t.Fatal("material expiry destroyed application session")
	}
	_, _ = f.s.store.db.Exec("UPDATE sessions SET expires=?", time.Now().Add(-time.Minute).Unix())
	if r := call("GET", "/quota", "", user); r.StatusCode != 401 {
		t.Fatal("expired app session accepted")
	}
}
