package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const flowCookie = "cram_auth_flow"
const integrationScope = "entry materials:read"
const oldSiteAccessBeta = "beta"
const oldSiteAccessPublic = "public"

type oldSiteConfig struct {
	publicURL, issuer, entryURL, authorizeURL, tokenURL, revokeURL string
	clientID, clientSecret                                         string
	accessMode                                                     string
	allowed                                                        map[string]bool
	key                                                            []byte
}

func trustedURL(raw string, originOnly bool) (*url.URL, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("invalid integration URL")
	}
	loopback := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return nil, fmt.Errorf("integration URLs require HTTPS (HTTP is allowed only on loopback)")
	}
	if originOnly && u.Path != "" && u.Path != "/" {
		return nil, fmt.Errorf("APP_PUBLIC_URL must be an origin without a path")
	}
	return u, nil
}

func (o *oldSiteConfig) load() error {
	o.accessMode = env("APP_OLD_SITE_ACCESS_MODE", oldSiteAccessBeta)
	if o.accessMode != oldSiteAccessBeta && o.accessMode != oldSiteAccessPublic {
		return fmt.Errorf("APP_OLD_SITE_ACCESS_MODE must be beta or public")
	}
	o.publicURL = strings.TrimRight(os.Getenv("APP_PUBLIC_URL"), "/")
	_, e := trustedURL(o.publicURL, true)
	if e != nil {
		return fmt.Errorf("APP_PUBLIC_URL: %w", e)
	}
	base := strings.TrimRight(os.Getenv("OLD_SITE_URL"), "/")
	if _, e = trustedURL(base, true); e != nil {
		return fmt.Errorf("OLD_SITE_URL: %w", e)
	}
	o.issuer = base
	o.entryURL = base + "/cramameleon"
	o.authorizeURL = base + "/integrations/cramameleon/authorize"
	o.tokenURL = base + "/api/integrations/cramameleon/token"
	o.revokeURL = base + "/api/integrations/cramameleon/revoke"
	o.clientID = os.Getenv("OLD_SITE_CLIENT_ID")
	o.clientSecret = os.Getenv("OLD_SITE_CLIENT_SECRET")
	if !validID(o.clientID) || len(o.clientSecret) < 32 || strings.Contains(strings.ToLower(o.clientSecret), "replace") {
		return fmt.Errorf("valid OLD_SITE_CLIENT_ID and a separate random OLD_SITE_CLIENT_SECRET are required")
	}
	o.key, e = hex.DecodeString(os.Getenv("APP_CREDENTIAL_KEY"))
	if e != nil || len(o.key) != 32 {
		return fmt.Errorf("APP_CREDENTIAL_KEY must contain 64 hexadecimal characters")
	}
	o.allowed = map[string]bool{}
	for _, id := range strings.Split(os.Getenv("APP_ALLOWED_OLD_USER_IDS"), ",") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if !validSubject(id) {
			return fmt.Errorf("invalid APP_ALLOWED_OLD_USER_IDS")
		}
		o.allowed[id] = true
	}
	if o.accessMode == oldSiteAccessBeta && len(o.allowed) == 0 {
		return fmt.Errorf("APP_ALLOWED_OLD_USER_IDS must explicitly allow at least one old-site user")
	}
	return nil
}

func (o oldSiteConfig) mode() string {
	if o.accessMode == oldSiteAccessPublic {
		return oldSiteAccessPublic
	}
	return oldSiteAccessBeta
}

func (o oldSiteConfig) allows(subject string) bool {
	return validSubject(subject) && (o.mode() == oldSiteAccessPublic || o.allowed[subject])
}

func validSubject(s string) bool {
	n, e := strconv.ParseInt(s, 10, 64)
	return e == nil && n > 0 && strconv.FormatInt(n, 10) == s
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func seal(key []byte, text, binding string) ([]byte, error) {
	b, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	g, e := cipher.NewGCM(b)
	if e != nil {
		return nil, e
	}
	nonce := make([]byte, g.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return nil, e
	}
	return g.Seal(nonce, nonce, []byte(text), []byte(binding)), nil
}

func unseal(key, encrypted []byte, binding string) (string, error) {
	b, e := aes.NewCipher(key)
	if e != nil {
		return "", e
	}
	g, e := cipher.NewGCM(b)
	if e != nil || len(encrypted) < g.NonceSize() {
		return "", errors.New("invalid encrypted credential")
	}
	plain, e := g.Open(nil, encrypted[:g.NonceSize()], encrypted[g.NonceSize():], []byte(binding))
	return string(plain), e
}

func (s *appServer) mode() string {
	if s.cfg.mode == "old-site" {
		return "old-site"
	}
	if s.cfg.allowGuest {
		return "guest"
	}
	return "internal"
}

func (s *appServer) setSessionCookie(c *gin.Context, token string, age int) {
	sameSite := http.SameSiteStrictMode
	if s.mode() == "old-site" {
		sameSite = http.SameSiteLaxMode
	}
	http.SetCookie(c.Writer, &http.Cookie{Name: cookieName, Value: token, Path: "/", MaxAge: age, HttpOnly: true, Secure: strings.HasPrefix(s.cfg.oldSite.publicURL, "https://"), SameSite: sameSite})
}

func (s *appServer) setFlowCookie(c *gin.Context, token string, age int) {
	http.SetCookie(c.Writer, &http.Cookie{Name: flowCookie, Value: token, Path: "/api/auth/old-site", MaxAge: age, HttpOnly: true, Secure: strings.HasPrefix(s.cfg.oldSite.publicURL, "https://"), SameSite: http.SameSiteLaxMode})
}

type initialContext struct {
	MaterialID string `json:"materialId,omitempty"`
	PackageID  string `json:"packageId,omitempty"`
	ItemID     string `json:"itemId,omitempty"`
	ImportID   string `json:"importId,omitempty"`
}

func readInitialContext(c *gin.Context) (initialContext, error) {
	get := c.Query
	if c.Request.Method == http.MethodPost {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
		if err := c.Request.ParseForm(); err != nil {
			return initialContext{}, err
		}
		get = c.Request.PostForm.Get
	}
	v := initialContext{MaterialID: get("materialId"), PackageID: get("packageId"), ItemID: get("itemId")}
	for _, id := range []string{v.MaterialID, v.PackageID, v.ItemID} {
		if id != "" && !validSubject(id) {
			return v, errors.New("invalid resource ID")
		}
	}
	if v.MaterialID != "" && (v.PackageID != "" || v.ItemID != "") || v.ItemID != "" && v.PackageID == "" {
		return v, errors.New("invalid resource context")
	}
	return v, nil
}

func (s *appServer) startOldSiteAuth(c *gin.Context) {
	resource, e := readInitialContext(c)
	if e != nil || c.Request.Method == http.MethodPost && resource.MaterialID == "" && resource.PackageID == "" {
		fail(c, 400, "INVALID_REQUEST", "资料入口参数不正确")
		return
	}
	state, e := randomToken()
	if e != nil {
		fail(c, 500, "AUTH_FAILED", "无法发起授权")
		return
	}
	browser, e := randomToken()
	if e != nil {
		fail(c, 500, "AUTH_FAILED", "无法发起授权")
		return
	}
	verifier, e := randomToken()
	if e != nil {
		fail(c, 500, "AUTH_FAILED", "无法发起授权")
		return
	}
	stateHash := tokenHash(state)
	sealed, e := seal(s.cfg.oldSite.key, verifier, stateHash)
	if e != nil {
		fail(c, 500, "AUTH_FAILED", "无法保存授权流程")
		return
	}
	ctxJSON, _ := json.Marshal(resource)
	flowContext := ctxJSON
	if c.Request.Method == http.MethodPost {
		// Only a form submitted from the old site's resource page can request automatic import.
		resource.ImportID = stateHash
		flowContext, _ = json.Marshal(resource)
	}
	tx, e := s.store.db.BeginTx(c.Request.Context(), nil)
	if e != nil {
		fail(c, 503, "STORAGE_FAILED", "授权存储暂不可用")
		return
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	if _, e = tx.Exec("DELETE FROM auth_flows WHERE expires<=?", now); e != nil {
		fail(c, 503, "STORAGE_FAILED", "授权存储暂不可用")
		return
	}
	if old, _ := c.Cookie(flowCookie); old != "" {
		if _, e = tx.Exec("DELETE FROM auth_flows WHERE browser_hash=?", tokenHash(old)); e != nil {
			fail(c, 503, "STORAGE_FAILED", "授权存储暂不可用")
			return
		}
	}
	var count int
	if e = tx.QueryRow("SELECT COUNT(*) FROM auth_flows").Scan(&count); e != nil {
		fail(c, 503, "STORAGE_FAILED", "授权存储暂不可用")
		return
	}
	if count >= 256 {
		fail(c, 429, "AUTH_FLOW_LIMIT", "授权请求较多，请稍后再试")
		return
	}
	if _, e = tx.Exec("INSERT INTO auth_flows VALUES(?,?,?,?,?)", stateHash, tokenHash(browser), sealed, string(flowContext), now+300); e != nil {
		fail(c, 503, "STORAGE_FAILED", "无法保存授权流程")
		return
	}
	if e = tx.Commit(); e != nil {
		fail(c, 503, "STORAGE_FAILED", "无法保存授权流程")
		return
	}
	challenge := sha256.Sum256([]byte(verifier))
	u, _ := url.Parse(s.cfg.oldSite.authorizeURL)
	q := u.Query()
	q.Set("client_id", s.cfg.oldSite.clientID)
	q.Set("redirect_uri", s.cfg.oldSite.publicURL+"/api/auth/old-site/callback")
	q.Set("response_type", "code")
	q.Set("state", state)
	q.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
	q.Set("code_challenge_method", "S256")
	q.Set("scope", integrationScope)
	q.Set("context", string(ctxJSON))
	u.RawQuery = q.Encode()
	s.setFlowCookie(c, browser, 300)
	c.Redirect(http.StatusSeeOther, u.String())
}

func (s *appServer) entryFailed(c *gin.Context, code string) {
	s.setFlowCookie(c, "", -1)
	c.Redirect(http.StatusSeeOther, s.cfg.oldSite.publicURL+"/?entryError="+url.QueryEscape(code))
}

type entryToken struct {
	Issuer      string `json:"issuer"`
	Subject     string `json:"subject"`
	Name        string `json:"name"`
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
	Scope       string `json:"scope"`
}

func (s *appServer) finishOldSiteAuth(c *gin.Context) {
	state, code := c.Query("state"), c.Query("code")
	browser, _ := c.Cookie(flowCookie)
	if len(state) != 43 || len(browser) != 43 || len(code) < 32 || len(code) > 256 || c.Query("error") != "" {
		s.entryFailed(c, "AUTH_FLOW_INVALID")
		return
	}
	stateHash := tokenHash(state)
	var encrypted []byte
	var contextJSON string
	// DELETE RETURNING consumes the browser-bound flow atomically, including concurrent callbacks.
	e := s.store.db.QueryRowContext(c.Request.Context(), "DELETE FROM auth_flows WHERE state_hash=? AND browser_hash=? AND expires>? RETURNING verifier,context", stateHash, tokenHash(browser), time.Now().Unix()).Scan(&encrypted, &contextJSON)
	if e != nil {
		if errors.Is(e, sql.ErrNoRows) {
			s.entryFailed(c, "AUTH_FLOW_EXPIRED")
		} else {
			s.entryFailed(c, "STORAGE_FAILED")
		}
		return
	}
	verifier, e := unseal(s.cfg.oldSite.key, encrypted, stateHash)
	if e != nil {
		s.entryFailed(c, "AUTH_FLOW_INVALID")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {s.cfg.oldSite.publicURL + "/api/auth/old-site/callback"}, "code_verifier": {verifier}, "client_id": {s.cfg.oldSite.clientID}}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.oldSite.tokenURL, strings.NewReader(form.Encode()))
	if e != nil {
		s.entryFailed(c, "AUTH_FAILED")
		return
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(s.cfg.oldSite.clientID, s.cfg.oldSite.clientSecret)
	response, e := s.client.Do(req)
	if e != nil {
		s.entryFailed(c, "OLD_SITE_UNAVAILABLE")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		s.entryFailed(c, "AUTH_CODE_INVALID")
		return
	}
	body, e := io.ReadAll(io.LimitReader(response.Body, 16385))
	var identity entryToken
	if e != nil || len(body) > 16384 || json.Unmarshal(body, &identity) != nil || identity.Issuer != s.cfg.oldSite.issuer || !validSubject(identity.Subject) || len(identity.AccessToken) < 32 || len(identity.AccessToken) > 4096 || identity.ExpiresIn <= 0 || identity.ExpiresIn > 8*3600 || identity.Scope != integrationScope {
		s.entryFailed(c, "AUTH_RESPONSE_INVALID")
		return
	}
	if !s.cfg.oldSite.allows(identity.Subject) {
		s.revokeCredential(ctx, identity.AccessToken)
		s.entryFailed(c, "ENTRY_NOT_ALLOWED")
		return
	}
	token, e := randomToken()
	if e != nil {
		s.revokeCredential(ctx, identity.AccessToken)
		s.entryFailed(c, "AUTH_FAILED")
		return
	}
	appUser := "arxiv-" + tokenHash(identity.Issuer + "\x00" + identity.Subject)[:32]
	tokenID := tokenHash(token)
	credential, e := seal(s.cfg.oldSite.key, identity.AccessToken, tokenID)
	if e != nil {
		s.revokeCredential(ctx, identity.AccessToken)
		s.entryFailed(c, "AUTH_FAILED")
		return
	}
	name := strings.TrimSpace(identity.Name)
	if name == "" || len(name) > 240 {
		name = "破壁计划同学"
	}
	tx, e := s.store.db.BeginTx(c.Request.Context(), nil)
	if e != nil {
		s.revokeCredential(ctx, identity.AccessToken)
		s.entryFailed(c, "STORAGE_FAILED")
		return
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	if _, e = tx.Exec("INSERT INTO app_users(id,issuer,subject,name) VALUES(?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET name=excluded.name", appUser, identity.Issuer, identity.Subject, name); e == nil {
		_, e = tx.Exec("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)", tokenID, appUser, now+8*3600)
	}
	if e == nil {
		_, e = tx.Exec("INSERT INTO entry_sessions(token_hash,credential,credential_expires,context) VALUES(?,?,?,?)", tokenID, credential, now+identity.ExpiresIn, contextJSON)
	}
	var previousCredential []byte
	previousHash := ""
	if old, _ := c.Cookie(cookieName); e == nil && old != "" {
		previousHash = tokenHash(old)
		err := tx.QueryRow("SELECT credential FROM entry_sessions WHERE token_hash=?", previousHash).Scan(&previousCredential)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			e = err
		}
		if e == nil {
			_, e = tx.Exec("DELETE FROM entry_sessions WHERE token_hash=?", previousHash)
		}
		if e == nil {
			_, e = tx.Exec("DELETE FROM sessions WHERE token_hash=?", previousHash)
		}
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		_ = tx.Rollback()
		s.revokeCredential(ctx, identity.AccessToken)
		s.entryFailed(c, "STORAGE_FAILED")
		return
	}
	if previous, err := unseal(s.cfg.oldSite.key, previousCredential, previousHash); err == nil {
		s.revokeCredential(ctx, previous)
	}
	s.setFlowCookie(c, "", -1)
	s.setSessionCookie(c, token, 8*3600)
	c.Redirect(http.StatusSeeOther, s.cfg.oldSite.publicURL+"/")
}

func (s *appServer) authenticate(c *gin.Context) {
	if s.mode() == "guest" {
		c.Set("userID", guestUserID)
		c.Set("userName", "访客")
		c.Set("clientKey", "guest/"+c.ClientIP())
		c.Next()
		return
	}
	token, e := c.Cookie(cookieName)
	if e != nil || len(token) > 128 {
		fail(c, 401, "AUTH_REQUIRED", "应用会话已失效，请重新进入")
		return
	}
	hash := tokenHash(token)
	var user string
	e = s.store.db.QueryRowContext(c.Request.Context(), "SELECT user_id FROM sessions WHERE token_hash=? AND expires>?", hash, time.Now().Unix()).Scan(&user)
	if errors.Is(e, sql.ErrNoRows) {
		fail(c, 401, "AUTH_REQUIRED", "应用会话已失效，请重新进入")
		return
	}
	if e != nil {
		fail(c, 503, "STORAGE_FAILED", "会话存储暂不可用")
		return
	}
	if s.mode() == "internal" {
		// Never accept old-site sessions in internal mode, or legacy internal sessions in old-site mode.
		var fromOldSite bool
		if err := s.store.db.QueryRowContext(c.Request.Context(), "SELECT EXISTS(SELECT 1 FROM entry_sessions WHERE token_hash=?)", hash).Scan(&fromOldSite); err != nil {
			fail(c, 503, "STORAGE_FAILED", "会话存储暂不可用")
			return
		}
		if user != s.cfg.userID || fromOldSite {
			fail(c, 401, "AUTH_REQUIRED", "应用会话已失效，请重新进入")
			return
		}
		c.Set("userName", "内部开发者")
	} else {
		var subject, issuer, name, contextJSON string
		var expires int64
		e = s.store.db.QueryRowContext(c.Request.Context(), "SELECT u.subject,u.issuer,u.name,e.credential_expires,e.context FROM entry_sessions e JOIN app_users u ON u.id=? WHERE e.token_hash=?", user, hash).Scan(&subject, &issuer, &name, &expires, &contextJSON)
		if errors.Is(e, sql.ErrNoRows) {
			fail(c, 401, "AUTH_REQUIRED", "请从破壁计划重新进入")
			return
		}
		if e != nil {
			fail(c, 503, "STORAGE_FAILED", "会话存储暂不可用")
			return
		}
		if issuer != s.cfg.oldSite.issuer || !validSubject(subject) {
			fail(c, 401, "AUTH_REQUIRED", "请从破壁计划重新进入")
			return
		}
		if !s.cfg.oldSite.allows(subject) {
			fail(c, 403, "ENTRY_NOT_ALLOWED", "当前账号暂不可进入，请重新通过破壁计划授权或联系项目维护者")
			return
		}
		c.Set("userName", name)
		if c.Request.Method != http.MethodGet && c.GetHeader("X-Cram-User") != user {
			fail(c, 409, "SESSION_CHANGED", "账号已在其他页面切换，请刷新后再继续")
			return
		}
		c.Set("oldSubject", subject)
		status := "ready"
		if expires <= time.Now().Unix() {
			status = "expired"
		}
		c.Set("materialAuthStatus", status)
		var resource initialContext
		if json.Unmarshal([]byte(contextJSON), &resource) == nil {
			c.Set("initialContext", resource)
		}
	}
	c.Set("userID", user)
	c.Set("sessionHash", hash)
	c.Next()
}

func (s *appServer) revokeCredential(ctx context.Context, token string) {
	if token == "" || s.cfg.oldSite.revokeURL == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.oldSite.revokeURL, strings.NewReader(url.Values{"token": {token}}.Encode()))
	if e != nil {
		return
	}
	req.SetBasicAuth(s.cfg.oldSite.clientID, s.cfg.oldSite.clientSecret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, e := s.client.Do(req)
	if e == nil {
		response.Body.Close()
	}
}

func (s *appServer) removeSession(ctx context.Context, hash string) error {
	var encrypted []byte
	if s.mode() == "old-site" {
		e := s.store.db.QueryRowContext(ctx, "SELECT credential FROM entry_sessions WHERE token_hash=?", hash).Scan(&encrypted)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return e
		}
	}
	tx, e := s.store.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("DELETE FROM entry_sessions WHERE token_hash=?", hash); e != nil {
		return e
	}
	if _, e = tx.Exec("DELETE FROM sessions WHERE token_hash=?", hash); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	if token, e := unseal(s.cfg.oldSite.key, encrypted, hash); e == nil {
		s.revokeCredential(ctx, token)
	}
	return nil
}
