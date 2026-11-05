package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type authFixture struct {
	s                      *appServer
	app, old               *httptest.Server
	client                 *http.Client
	mu                     sync.Mutex
	challenge, subject     string
	exchanges, revocations int
}

func oldAuth(t *testing.T) *authFixture {
	t.Helper()
	f := &authFixture{subject: "42"}
	f.old = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		client, secret, ok := r.BasicAuth()
		if !ok || client != "cramameleon" || secret != strings.Repeat("s", 32) {
			t.Error("missing client authentication")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/revoke" {
			f.revocations++
			w.WriteHeader(204)
			return
		}
		if r.URL.Path != "/token" {
			w.WriteHeader(404)
			return
		}
		f.exchanges++
		if r.ParseForm() != nil || r.Form.Get("code") != strings.Repeat("c", 43) || r.Form.Get("redirect_uri") != "http://127.0.0.1:19999/api/auth/old-site/callback" || r.Form.Get("grant_type") != "authorization_code" {
			t.Error("invalid exchange request")
			w.WriteHeader(400)
			return
		}
		challenge := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if base64.RawURLEncoding.EncodeToString(challenge[:]) != f.challenge {
			t.Error("PKCE did not match")
			w.WriteHeader(400)
			return
		}
		json.NewEncoder(w).Encode(entryToken{Issuer: f.old.URL, Subject: f.subject, Name: "真实同学", AccessToken: strings.Repeat("credential", 5), ExpiresIn: 3600, Scope: integrationScope})
	}))
	t.Cleanup(f.old.Close)
	db, e := openStore(filepath.Join(t.TempDir(), "auth.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.db.Close() })
	cfg := config{mode: "old-site", staticDir: t.TempDir(), model: "deepseek-flash", userID: "internal-developer", dailyBudget: 100000, maxInput: 64000, maxOutput: 512, timeout: time.Second,
		oldSite: oldSiteConfig{publicURL: "http://127.0.0.1:19999", issuer: f.old.URL, entryURL: f.old.URL + "/cramameleon", authorizeURL: f.old.URL + "/authorize", tokenURL: f.old.URL + "/token", revokeURL: f.old.URL + "/revoke", clientID: "cramameleon", clientSecret: strings.Repeat("s", 32), key: []byte(strings.Repeat("k", 32)), allowed: map[string]bool{"42": true, "43": true}}}
	server, router := newServer(cfg, db)
	f.s = server
	f.app = httptest.NewServer(router)
	t.Cleanup(f.app.Close)
	jar, _ := cookiejar.New(nil)
	f.client = &http.Client{Jar: jar, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return f
}

func (f *authFixture) start(t *testing.T, suffix string) string {
	t.Helper()
	r, e := f.client.Get(f.app.URL + "/api/auth/old-site/start" + suffix)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	if r.StatusCode != 303 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("start %d %s", r.StatusCode, b)
	}
	u, e := url.Parse(r.Header.Get("Location"))
	if e != nil {
		t.Fatal(e)
	}
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("client_id") != "cramameleon" || q.Get("scope") != integrationScope {
		t.Fatal("invalid authorization redirect")
	}
	f.mu.Lock()
	f.challenge = q.Get("code_challenge")
	f.mu.Unlock()
	for _, cookie := range r.Cookies() {
		if cookie.Name == flowCookie && (!cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode) {
			t.Fatal("flow cookie cannot survive top-level callback")
		}
	}
	return q.Get("state")
}

func (f *authFixture) callback(t *testing.T, state string) *http.Response {
	t.Helper()
	r, e := f.client.Get(f.app.URL + "/api/auth/old-site/callback?state=" + url.QueryEscape(state) + "&code=" + strings.Repeat("c", 43))
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	return r
}

func (f *authFixture) session(t *testing.T) (int, map[string]any) {
	t.Helper()
	r, e := f.client.Get(f.app.URL + "/api/session")
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	var v map[string]any
	if e = json.NewDecoder(r.Body).Decode(&v); e != nil {
		t.Fatal(e)
	}
	return r.StatusCode, v
}

func TestOldSiteAuthorizationIdentityAndIsolation(t *testing.T) {
	f := oldAuth(t)
	state := f.start(t, "?packageId=12&itemId=34")
	r := f.callback(t, state)
	if r.StatusCode != 303 || r.Header.Get("Location") != "http://127.0.0.1:19999/" {
		t.Fatal("callback failed", r.Header)
	}
	status, v := f.session(t)
	if status != 200 {
		t.Fatal(status, v)
	}
	u := v["user"].(map[string]any)
	firstUser := u["id"].(string)
	if u["name"] != "真实同学" || firstUser == "internal-developer" || v["mode"] != "old-site" {
		t.Fatal(v)
	}
	resource := v["initialContext"].(map[string]any)
	if resource["packageId"] != "12" || resource["itemId"] != "34" {
		t.Fatal(resource)
	}
	encoded, _ := json.Marshal(v)
	if strings.Contains(string(encoded), "credential") {
		t.Fatal("credential leaked into session response")
	}
	var encrypted []byte
	if e := f.s.store.db.QueryRow("SELECT credential FROM entry_sessions").Scan(&encrypted); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(encrypted), strings.Repeat("credential", 5)) {
		t.Fatal("upstream credential stored in plaintext")
	}
	f.mu.Lock()
	f.subject = "43"
	f.mu.Unlock()
	f.callback(t, f.start(t, ""))
	status, v = f.session(t)
	if status != 200 || v["user"].(map[string]any)["id"] == firstUser {
		t.Fatal("old-site users collapsed into shared identity", v)
	}
	var count int
	f.s.store.db.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&count)
	if count != 1 {
		t.Fatal("previous session not rotated", count)
	}
}

func TestOldSiteCallbackRequiresBrowserStateAndOnlyExchangesOnce(t *testing.T) {
	f := oldAuth(t)
	state := f.start(t, "")
	other := &http.Client{CheckRedirect: f.client.CheckRedirect}
	r, e := other.Get(f.app.URL + "/api/auth/old-site/callback?state=" + state + "&code=" + strings.Repeat("c", 43))
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if !strings.Contains(r.Header.Get("Location"), "entryError=") {
		t.Fatal("accepted unbound callback")
	}
	f.mu.Lock()
	n := f.exchanges
	f.mu.Unlock()
	if n != 0 {
		t.Fatal("unbound callback reached upstream")
	}
	f.callback(t, state)
	f.callback(t, state)
	f.mu.Lock()
	n = f.exchanges
	f.mu.Unlock()
	if n != 1 {
		t.Fatal("flow exchanged more than once", n)
	}
}

func TestOldSiteModeRejectsInternalLoginAndLegacySessions(t *testing.T) {
	f := oldAuth(t)
	req, _ := http.NewRequest("POST", f.app.URL+"/api/internal/session", strings.NewReader(`{"accessToken":"test"}`))
	req.Header.Set("Origin", f.s.cfg.oldSite.publicURL)
	r, e := f.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 404 {
		t.Fatal("internal entry remains in old-site mode", r.StatusCode)
	}
	f.s.store.db.Exec("INSERT INTO sessions VALUES(?,?,?)", tokenHash("legacy"), "internal-developer", time.Now().Add(time.Hour).Unix())
	u, _ := url.Parse(f.app.URL)
	f.client.Jar.SetCookies(u, []*http.Cookie{{Name: cookieName, Value: "legacy", Path: "/"}})
	status, _ := f.session(t)
	if status != 401 {
		t.Fatal("legacy internal cookie entered old-site mode")
	}
}

func TestOldSiteAllowlistExpiryAndLogout(t *testing.T) {
	f := oldAuth(t)
	f.mu.Lock()
	f.subject = "99"
	f.mu.Unlock()
	r := f.callback(t, f.start(t, ""))
	if !strings.Contains(r.Header.Get("Location"), "ENTRY_NOT_ALLOWED") {
		t.Fatal(r.Header)
	}
	f.mu.Lock()
	n := f.revocations
	f.subject = "42"
	f.mu.Unlock()
	if n != 1 {
		t.Fatal("unapproved upstream grant was not revoked")
	}
	f.callback(t, f.start(t, ""))
	f.s.store.db.Exec("UPDATE entry_sessions SET credential_expires=0")
	status, v := f.session(t)
	if status != 200 || v["oldSite"].(map[string]any)["status"] != "expired" {
		t.Fatal("remote expiry terminated application", status, v)
	}
	req, _ := http.NewRequest("POST", f.app.URL+"/api/logout", nil)
	r, e := f.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatal("missing origin bypassed CSRF check")
	}
	req, _ = http.NewRequest("POST", f.app.URL+"/api/logout", nil)
	req.Header.Set("Origin", f.s.cfg.oldSite.publicURL)
	req.Header.Set("X-Cram-User", v["user"].(map[string]any)["id"].(string))
	r, e = f.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 204 {
		t.Fatal(r.StatusCode)
	}
	status, _ = f.session(t)
	if status != 401 {
		t.Fatal("logout failed")
	}
	var count int
	f.s.store.db.QueryRow("SELECT COUNT(*) FROM entry_sessions").Scan(&count)
	if count != 0 {
		t.Fatal("logout retained upstream credential")
	}
}

func TestOldSiteConfigFailsClosed(t *testing.T) {
	t.Setenv("APP_ENV", "old-site")
	t.Setenv("APP_PUBLIC_URL", "https://learn.example.com")
	t.Setenv("OLD_SITE_URL", "https://old.example.com")
	t.Setenv("OLD_SITE_CLIENT_ID", "cramameleon")
	t.Setenv("OLD_SITE_CLIENT_SECRET", strings.Repeat("s", 32))
	t.Setenv("APP_CREDENTIAL_KEY", strings.Repeat("ab", 32))
	t.Setenv("APP_ALLOWED_OLD_USER_IDS", "42,43")
	t.Setenv("APP_OLD_SITE_ACCESS_MODE", "")
	t.Setenv("APP_ACCESS_TOKEN", "")
	if cfg, e := loadConfig(); e != nil || cfg.oldSite.mode() != oldSiteAccessBeta {
		t.Fatal(e)
	}
	for _, item := range []struct{ key, value string }{{"APP_ALLOWED_OLD_USER_IDS", ""}, {"APP_ALLOWED_OLD_USER_IDS", "*"}, {"APP_CREDENTIAL_KEY", "short"}, {"OLD_SITE_URL", "http://old.example.com"}, {"APP_PUBLIC_URL", "https://learn.example.com/other"}, {"OLD_SITE_URL", "https://untrusted@old.example.com"}} {
		t.Run(item.key+item.value, func(t *testing.T) {
			t.Setenv(item.key, item.value)
			if _, e := loadConfig(); e == nil {
				t.Fatal("accepted unsafe configuration")
			}
		})
	}
	t.Run("public keeps optional allowlist validated", func(t *testing.T) {
		t.Setenv("APP_OLD_SITE_ACCESS_MODE", "public")
		cfg, e := loadConfig()
		if e != nil || !cfg.oldSite.allowed["42"] || !cfg.oldSite.allows("99") {
			t.Fatal("public mode lost the retained list or denied a valid identity", e)
		}
		t.Setenv("APP_ALLOWED_OLD_USER_IDS", "")
		if _, e = loadConfig(); e != nil {
			t.Fatal("public mode requires an allowlist", e)
		}
		t.Setenv("APP_ALLOWED_OLD_USER_IDS", "*")
		if _, e = loadConfig(); e == nil {
			t.Fatal("public mode accepted a malformed retained list")
		}
	})
	t.Run("unknown access mode", func(t *testing.T) {
		t.Setenv("APP_OLD_SITE_ACCESS_MODE", "open")
		if _, e := loadConfig(); e == nil {
			t.Fatal("accepted unknown access mode")
		}
	})
}

func TestOldSitePublicAccessAndBetaSwitch(t *testing.T) {
	f := oldAuth(t)
	f.s.cfg.oldSite.accessMode = oldSiteAccessPublic
	f.mu.Lock()
	f.subject = "99" // Not in the retained beta list.
	f.mu.Unlock()
	if status, _ := f.session(t); status != 401 {
		t.Fatal("public mode bypassed old-site authorization", status)
	}
	r := f.callback(t, f.start(t, ""))
	if r.StatusCode != 303 || strings.Contains(r.Header.Get("Location"), "entryError=") {
		t.Fatal("public mode rejected a normally authorized old-site user", r.Header)
	}
	for _, mode := range []string{oldSiteAccessPublic, oldSiteAccessBeta, oldSiteAccessPublic} {
		f.s.cfg.oldSite.accessMode = mode
		status, v := f.session(t)
		if mode == oldSiteAccessBeta {
			if status != 403 || v["error"].(map[string]any)["code"] != "ENTRY_NOT_ALLOWED" {
				t.Fatal("switching to beta did not restrict the existing session", status, v)
			}
		} else if status != 200 || v["oldSite"].(map[string]any)["accessMode"] != mode {
			t.Fatal("public session unavailable", status, v)
		}
		for _, path := range []string{"/api/health", "/api/auth/config"} {
			r, e := f.client.Get(f.app.URL + path)
			if e != nil {
				t.Fatal(e)
			}
			var metadata map[string]any
			e = json.NewDecoder(r.Body).Decode(&metadata)
			r.Body.Close()
			if e != nil || r.StatusCode != 200 || metadata["oldSiteAccessMode"] != mode {
				t.Fatal("incorrect access mode metadata", path, metadata, e)
			}
			if _, leaked := metadata["allowed"]; leaked {
				t.Fatal("allowlist exposed in entry metadata")
			}
		}
	}
	if len(f.s.cfg.oldSite.allowed) != 2 || !f.s.cfg.oldSite.allowed["42"] || f.s.cfg.oldSite.allowed["99"] {
		t.Fatal("switching modes changed the beta list")
	}
	if _, e := f.s.store.db.Exec("UPDATE app_users SET issuer='https://untrusted.example'"); e != nil {
		t.Fatal(e)
	}
	if status, _ := f.session(t); status != 401 {
		t.Fatal("public mode accepted an untrusted identity issuer", status)
	}
}

func TestExpiredFlowAndInvalidResourceNeverExchange(t *testing.T) {
	f := oldAuth(t)
	for _, suffix := range []string{"?materialId=1&packageId=2", "?itemId=3", "?materialId=../other", "?packageId=-1"} {
		r, e := f.client.Get(f.app.URL + "/api/auth/old-site/start" + suffix)
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		if r.StatusCode != 400 {
			t.Fatal("invalid resource context accepted", suffix)
		}
	}
	state := f.start(t, "")
	f.s.store.db.Exec("UPDATE auth_flows SET expires=0")
	r := f.callback(t, state)
	if !strings.Contains(r.Header.Get("Location"), "AUTH_FLOW_EXPIRED") {
		t.Fatal(r.Header)
	}
	f.mu.Lock()
	n := f.exchanges
	f.mu.Unlock()
	if n != 0 {
		t.Fatal("expired flow reached token endpoint")
	}
}

func TestEncryptedCredentialsAreBoundToTheirSession(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	value, e := seal(key, "private-credential", "session-A")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = unseal(key, value, "session-B"); e == nil {
		t.Fatal("credential moved between sessions")
	}
	if _, e = unseal(key, []byte("short"), "session-A"); e == nil {
		t.Fatal("truncated encryption accepted")
	}
	if plain, e := unseal(key, value, "session-A"); e != nil || plain != "private-credential" {
		t.Fatal(plain, e)
	}
}

func TestAccountSwitchRejectsStaleTabBeforeModelOrLogout(t *testing.T) {
	f := oldAuth(t)
	f.callback(t, f.start(t, ""))
	_, v := f.session(t)
	oldUser := v["user"].(map[string]any)["id"].(string)
	f.mu.Lock()
	f.subject = "43"
	f.mu.Unlock()
	f.callback(t, f.start(t, ""))
	for _, path := range []string{"/api/model", "/api/logout"} {
		req, _ := http.NewRequest("POST", f.app.URL+path, strings.NewReader("{}"))
		req.Header.Set("Origin", f.s.cfg.oldSite.publicURL)
		req.Header.Set("X-Cram-User", oldUser)
		r, e := f.client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != 409 || !strings.Contains(string(b), "SESSION_CHANGED") {
			t.Fatal(path, r.StatusCode, string(b))
		}
	}
	if code, _ := f.session(t); code != 200 {
		t.Fatal("stale tab logged out new user")
	}
}

func TestAutomaticImportRequiresOldSiteForm(t *testing.T) {
	f := oldAuth(t)
	const path = "/api/auth/old-site/start"
	for _, origin := range []string{"", "https://untrusted.example", f.s.cfg.oldSite.publicURL, f.old.URL} {
		req, err := http.NewRequest(http.MethodPost, f.app.URL+path, strings.NewReader("materialId=12"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", origin)
		r, err := f.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if origin != f.old.URL {
			if r.StatusCode != 403 {
				t.Fatalf("origin %q received %d", origin, r.StatusCode)
			}
			continue
		}
		if r.StatusCode != 303 {
			t.Fatal(r.StatusCode)
		}
		redirect, err := url.Parse(r.Header.Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		q := redirect.Query()
		if q.Get("context") != `{"materialId":"12"}` {
			t.Fatal("unexpected authorization context", q.Get("context"))
		}
		f.mu.Lock()
		f.challenge = q.Get("code_challenge")
		f.mu.Unlock()
		f.callback(t, q.Get("state"))
		status, session := f.session(t)
		context, _ := session["initialContext"].(map[string]any)
		if status != 200 || context["materialId"] != "12" || context["importId"] == nil {
			t.Fatalf("missing import intent: %d %v", status, context)
		}
	}
	f.callback(t, f.start(t, "?materialId=12&importId=forged"))
	_, session := f.session(t)
	if context := session["initialContext"].(map[string]any); context["importId"] != nil {
		t.Fatal("GET enabled automatic import")
	}
}
