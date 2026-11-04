package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

const cookieName = "cram_demo_session"

type config struct {
	bind, staticDir string
	delay           time.Duration
}
type demoServer struct {
	config    config
	sessions  sync.Map
	active    atomic.Int64
	requests  atomic.Int64
	completed atomic.Int64
	cancelled atomic.Int64
	slots     chan struct{}
	users     sync.Map
}
type modelRequest struct {
	ContractVersion string `json:"contractVersion"`
	RequestID       string `json:"requestId"`
	TurnID          string `json:"turnId"`
	Scenario        string `json:"scenario"`
	Messages        []struct {
		Role string `json:"role"`
	} `json:"messages"`
}

func (s *demoServer) fail(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": message}})
}
func (s *demoServer) validSession(c *gin.Context) bool {
	token, err := c.Cookie(cookieName)
	if err != nil {
		return false
	}
	expires, ok := s.sessions.Load(token)
	if !ok {
		return false
	}
	if time.Now().After(expires.(time.Time)) {
		s.sessions.Delete(token)
		return false
	}
	return true
}
func (s *demoServer) sameOrigin(c *gin.Context) bool {
	origin := c.GetHeader("Origin")
	return c.GetHeader("Sec-Fetch-Site") != "cross-site" && (origin == "" || origin == "http://"+c.Request.Host || origin == "https://"+c.Request.Host)
}
func newServer(cfg config) (*demoServer, *gin.Engine) {
	s := &demoServer{config: cfg, slots: make(chan struct{}, 2)}
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.Header("Cache-Control", "no-store")
		}
		if c.Request.Method != http.MethodGet && !s.sameOrigin(c) {
			s.fail(c, 403, "ORIGIN_REJECTED", "请求来源不被允许")
			return
		}
		c.Next()
	})
	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "mode": "demo", "backend": "Go / Gin", "agent": "Pi Core 1.5.0", "realModel": false, "oldSite": false, "database": false, "stats": gin.H{"active": s.active.Load(), "requests": s.requests.Load(), "completed": s.completed.Load(), "cancelled": s.cancelled.Load()}})
	})
	// TODO(auth): Replace this development-only entry with the old site's code exchange.
	r.POST("/api/demo/session", func(c *gin.Context) {
		if os.Getenv("APP_ENV") != "demo" || os.Getenv("APP_DEMO_AUTH_ENABLED") != "true" {
			s.fail(c, 404, "NOT_FOUND", "模拟入口未启用")
			return
		}
		bytes := make([]byte, 32)
		if _, err := rand.Read(bytes); err != nil {
			s.fail(c, 500, "SESSION_FAILED", "无法建立模拟会话")
			return
		}
		token := hex.EncodeToString(bytes)
		s.sessions.Range(func(key, value any) bool {
			if time.Now().After(value.(time.Time)) {
				s.sessions.Delete(key)
			}
			return true
		})
		s.sessions.Store(token, time.Now().Add(time.Hour))
		// HTTP is permitted only on loopback. TODO(auth): Secure cookies for production HTTPS.
		http.SetCookie(c.Writer, &http.Cookie{Name: cookieName, Value: token, Path: "/", MaxAge: 3600, HttpOnly: true, SameSite: http.SameSiteStrictMode})
		c.JSON(200, gin.H{"mode": "demo", "user": gin.H{"id": "demo-developer", "name": "内部开发者"}})
	})
	auth := r.Group("/api")
	auth.Use(func(c *gin.Context) {
		if !s.validSession(c) {
			s.fail(c, 401, "AUTH_REQUIRED", "请先通过模拟旧站入口进入")
			return
		}
		c.Next()
	})
	auth.GET("/session", func(c *gin.Context) {
		c.JSON(200, gin.H{"mode": "demo", "user": gin.H{"id": "demo-developer", "name": "内部开发者"}, "limits": gin.H{"maxToolCalls": 6, "timeoutSeconds": 120}})
	})
	auth.POST("/logout", func(c *gin.Context) {
		token, _ := c.Cookie(cookieName)
		s.sessions.Delete(token)
		http.SetCookie(c.Writer, &http.Cookie{Name: cookieName, Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
		c.Status(204)
	})
	auth.POST("/model", s.model)
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			s.fail(c, 404, "NOT_IMPLEMENTED", "TODO：此业务接口尚未接入")
			return
		}
		if c.Request.Method != http.MethodGet {
			c.Status(405)
			return
		}
		path := filepath.Clean("/" + c.Request.URL.Path)
		if path == "/" || path == "/index.html" {
			c.Header("Cache-Control", "no-cache")
			c.File(filepath.Join(cfg.staticDir, "index.html"))
			return
		}
		fullPath := filepath.Join(cfg.staticDir, strings.TrimPrefix(path, "/"))
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			c.Status(404)
			return
		}
		c.File(fullPath)
	})
	return s, r
}

func (s *demoServer) model(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 65536)
	var input modelRequest
	decoder := json.NewDecoder(c.Request.Body)
	if err := decoder.Decode(&input); err != nil {
		s.fail(c, 400, "INVALID_REQUEST", "请求格式不正确或超过大小限制")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		s.fail(c, 400, "INVALID_REQUEST", "请求只能包含一个 JSON 对象")
		return
	}
	if input.ContractVersion != "demo.v1" || input.RequestID == "" || len(input.RequestID) > 128 || input.TurnID == "" || len(input.Messages) == 0 || len(input.Messages) > 32 {
		s.fail(c, 400, "INVALID_REQUEST", "请求契约不匹配")
		return
	}
	if input.Scenario != "chat" && input.Scenario != "quiz" && input.Scenario != "slow" && input.Scenario != "error" {
		s.fail(c, 400, "INVALID_SCENARIO", "未知演示场景")
		return
	}
	// All fake sessions identify one demo developer: per-user concurrency is one.
	if _, loaded := s.users.LoadOrStore("demo-developer", true); loaded {
		s.fail(c, 429, "CONCURRENCY_LIMIT", "上一轮仍在结束，请稍后重试")
		return
	}
	defer s.users.Delete("demo-developer")
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		s.fail(c, 429, "CONCURRENCY_LIMIT", "并发已达上限")
		return
	}
	s.requests.Add(1)
	s.active.Add(1)
	defer s.active.Add(-1)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 120*time.Second)
	defer cancel()
	finished := false
	defer func() {
		if finished {
			s.completed.Add(1)
		} else {
			s.cancelled.Add(1)
		}
	}()
	c.Header("Content-Type", "text/event-stream; charset=utf-8")
	c.Header("X-Accel-Buffering", "no")
	c.Status(200)
	send := func(event any) bool {
		select {
		case <-ctx.Done():
			return false
		default:
		}
		data, err := json.Marshal(event)
		if err != nil {
			return false
		}
		if _, err = fmt.Fprintf(c.Writer, "data: %s\n\n", data); err != nil {
			return false
		}
		c.Writer.Flush()
		return true
	}
	pause := func(delay time.Duration) bool {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return true
		}
	}
	text := func(content string) bool {
		for _, character := range content {
			if !pause(s.config.delay) || !send(gin.H{"type": "text_delta", "delta": string(character)}) {
				return false
			}
		}
		return true
	}
	if !send(gin.H{"type": "start", "requestId": input.RequestID}) {
		return
	}
	if input.Scenario == "error" {
		if !pause(s.config.delay * 8) {
			return
		}
		send(gin.H{"type": "error", "code": "DEMO_MODEL_FAILURE", "message": "这是可控的模拟故障。切换场景后可再次发送。"})
		finished = true
		return
	}
	// TODO(model): Replace this deterministic fixture with the real DeepSeek stream.
	// This handler never executes tools or initiates the next model request.
	if input.Messages[len(input.Messages)-1].Role != "toolResult" {
		if !text("我会先调用一个演示工具，再继续回答。\n\n") {
			return
		}
		if !send(gin.H{"type": "tool_call", "id": "fixture-" + input.RequestID, "name": "demo_fixture", "arguments": gin.H{"scenario": input.Scenario}}) {
			return
		}
		finished = send(gin.H{"type": "finish", "stopReason": "toolUse"})
		return
	}
	if input.Scenario == "slow" {
		for index := 0; index < 8; index++ {
			if !text("这是一段用于检查停止与取消的慢速模拟响应。") {
				return
			}
		}
	} else {
		if !text("模拟链路已跑通。\n\nPi 在浏览器里执行了假工具，并将结果发回 Go 后端。你看到的文字来自第二次模拟模型请求。\n\n本次没有调用真实模型，也没有读取旧站账号、课程资料或业务数据。") {
			return
		}
	}
	finished = send(gin.H{"type": "finish", "stopReason": "stop"})
}

func main() {
	bind := os.Getenv("APP_BIND")
	if bind == "" {
		bind = "127.0.0.1:18085"
	}
	host, _, err := net.SplitHostPort(bind)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("Demo must bind to an explicit loopback IP")
	}
	if os.Getenv("APP_ENV") != "demo" || os.Getenv("APP_DEMO_AUTH_ENABLED") != "true" || os.Getenv("APP_REAL_MODEL_ENABLED") != "false" || os.Getenv("APP_ARXIV_ENABLED") != "false" || os.Getenv("APP_DATABASE_ENABLED") != "false" {
		log.Fatal("Demo requires explicit demo-only configuration; production integrations are TODO")
	}
	staticDir := os.Getenv("APP_STATIC_DIR")
	if staticDir == "" {
		staticDir = "dist"
	}
	_, router := newServer(config{bind: bind, staticDir: staticDir, delay: 22 * time.Millisecond})
	server := &http.Server{Addr: bind, Handler: router, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		log.Printf("Cramameleon demo listening on http://%s", bind)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	// TODO(database): Persistent production session, grants, and usage storage.
	// TODO(arxiv): Real entry-code exchange, scoped credentials, search and downloads.
}
