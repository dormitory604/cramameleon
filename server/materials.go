package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const remoteFileLimit int64 = 20 << 20

var materialRoute = regexp.MustCompile(`^/(quota|materials|packages|materials/[1-9][0-9]*|packages/[1-9][0-9]*|packages/[1-9][0-9]*/items|materials/[1-9][0-9]*/access|packages/[1-9][0-9]*/access|materials/[1-9][0-9]*/(parsed|evidence)|packages/[1-9][0-9]*/items/[1-9][0-9]*/(parsed|evidence))$`)

// The browser supplies resource IDs; the server alone selects the upstream
// origin, attaches the encrypted session credential, and rejects redirects.
func (s *appServer) materials(c *gin.Context) {
	if s.mode() != "old-site" {
		fail(c, 404, "NOT_FOUND", "请从破壁计划进入后使用课程资料")
		return
	}
	if c.GetHeader("X-Cram-User") != c.GetString("userID") {
		fail(c, 409, "SESSION_CHANGED", "账号已切换，请刷新后再继续")
		return
	}
	path := c.Param("path")
	access := strings.HasSuffix(path, "/access")
	if !materialRoute.MatchString(path) || (access && c.Request.Method != http.MethodPost) || (!access && c.Request.Method != http.MethodGet) {
		fail(c, 404, "NOT_FOUND", "资料接口不存在")
		return
	}
	parseRequest := strings.HasSuffix(path, "/parsed") || strings.HasSuffix(path, "/evidence")
	var view remoteView
	if parseRequest {
		var ok bool
		path, view, ok = parseRemoteView(c, path)
		if !ok {
			return
		}
	}
	var encrypted []byte
	var expires int64
	if e := s.store.db.QueryRowContext(c.Request.Context(), "SELECT credential,credential_expires FROM entry_sessions WHERE token_hash=?", c.GetString("sessionHash")).Scan(&encrypted, &expires); e != nil {
		fail(c, 503, "STORAGE_FAILED", "资料授权暂不可用")
		return
	}
	if expires <= time.Now().Unix() {
		fail(c, 401, "MATERIAL_AUTH_EXPIRED", "资料授权已过期，请从破壁计划重新进入")
		return
	}
	token, e := unseal(s.cfg.oldSite.key, encrypted, c.GetString("sessionHash"))
	if e != nil {
		fail(c, 503, "STORAGE_FAILED", "资料授权暂不可用")
		return
	}
	query := url.Values{}
	for key, values := range c.Request.URL.Query() {
		switch key {
		case "search", "course_name", "page", "page_size", "readId", "category":
			if len(values) != 1 || len(values[0]) > 500 {
				fail(c, 400, "INVALID_REQUEST", "资料查询参数不正确")
				return
			}
			query.Set(key, values[0])
		case "turnId", "callId", "startChunk", "query":
			if parseRequest && len(values) == 1 {
				continue
			}
			fallthrough
		default:
			fail(c, 400, "INVALID_REQUEST", "资料查询参数不正确")
			return
		}
	}
	if parseRequest {
		view.path = path
		view.session = c.GetString("sessionHash")
		if cached := s.remoteCache.get("document:" + view.session + ":" + path); cached != nil {
			s.sendRemoteView(c, view, cached)
			return
		}
		select {
		case s.parseSlots <- struct{}{}:
			defer func() { <-s.parseSlots }()
		default:
			fail(c, 429, "MATERIALS_BUSY", "资料解析繁忙，请稍后重试")
			return
		}
	}
	var body io.Reader
	if access {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
		data, e := io.ReadAll(c.Request.Body)
		if e != nil || !json.Valid(data) {
			fail(c, 400, "INVALID_REQUEST", "读取请求不正确")
			return
		}
		body = bytes.NewReader(data)
	}
	req, e := http.NewRequestWithContext(c.Request.Context(), c.Request.Method, s.cfg.oldSite.issuer+"/api/integrations/cramameleon"+path+"?"+query.Encode(), body)
	if e != nil {
		fail(c, 503, "OLD_SITE_UNAVAILABLE", "资料服务暂不可用")
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := *s.client
	client.Timeout = 45 * time.Second
	response, e := client.Do(req)
	if e != nil {
		fail(c, 502, "OLD_SITE_UNAVAILABLE", "资料服务暂不可用，请稍后重试")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var payload struct {
			Error struct{ Code, Message string }
		}
		_ = json.NewDecoder(io.LimitReader(response.Body, 16384)).Decode(&payload)
		if response.StatusCode == 401 {
			_, _ = s.store.db.ExecContext(c.Request.Context(), "UPDATE entry_sessions SET credential_expires=0 WHERE token_hash=?", c.GetString("sessionHash"))
			fail(c, 401, "MATERIAL_AUTH_EXPIRED", "资料授权已失效，请从破壁计划重新进入")
			return
		}
		allowed := map[string]bool{"INVALID_REQUEST": true, "MATERIAL_NOT_FOUND": true, "FILE_UNAVAILABLE": true, "QUOTA_EXCEEDED": true, "DAILY_REPEAT_LIMIT": true, "IDEMPOTENCY_CONFLICT": true, "ACCESS_EXPIRED": true, "READ_ACCESS_REQUIRED": true, "ACCESS_DENIED": true, "STORAGE_FAILED": true}
		if !allowed[payload.Error.Code] {
			fail(c, 502, "OLD_SITE_UNAVAILABLE", "资料服务暂不可用")
			return
		}
		fail(c, response.StatusCode, payload.Error.Code, payload.Error.Message)
		return
	}
	if strings.HasSuffix(path, "/content") {
		if response.ContentLength < 0 || response.ContentLength > remoteFileLimit {
			fail(c, 422, "FILE_UNAVAILABLE", "文件大小无法确认或超过 20 MB")
			return
		}
		s.parseRemoteMaterial(c, response, view)
		return
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if e != nil || len(data) > 2<<20 || !json.Valid(data) {
		fail(c, 502, "OLD_SITE_UNAVAILABLE", "资料服务返回了无效内容")
		return
	}
	c.Data(200, "application/json; charset=utf-8", data)
}
