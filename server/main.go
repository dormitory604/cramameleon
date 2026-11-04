package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	webpath "path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const contractVersion = "app.v1"
const cookieName = "cram_session"
const guestUserID = "guest/browser"

type config struct {
	bind, staticDir, dbPath, apiKey, model, accessToken, userID string
	mode                                                        string
	oldSite                                                     oldSiteConfig
	dailyBudget                                                 int64
	maxOutput, maxInput                                         int
	timeout                                                     time.Duration
	allowGuest                                                  bool
}
type appServer struct {
	cfg           config
	store         *store
	client        *http.Client
	endpoint      string
	slots         chan struct{}
	users         sync.Map
	loginMu       sync.Mutex
	loginFailures int
	loginWindow   time.Time
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func envInt(key string, fallback int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	n, e := strconv.Atoi(v)
	if e != nil || n <= 0 {
		return 0, fmt.Errorf("invalid %s", key)
	}
	return n, nil
}
func loadConfig() (config, error) {
	c := config{bind: env("APP_BIND", "127.0.0.1:18085"), staticDir: env("APP_STATIC_DIR", "dist"), dbPath: env("APP_DATABASE_PATH", "var/app.sqlite"), apiKey: os.Getenv("DEEPSEEK_API_KEY"), model: env("DEEPSEEK_MODEL", "deepseek-flash"), accessToken: os.Getenv("APP_ACCESS_TOKEN"), userID: env("APP_DEVELOPER_ID", "internal-developer"), timeout: 120 * time.Second}
	c.mode = env("APP_ENV", "internal")
	host, _, e := net.SplitHostPort(c.bind)
	if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return c, fmt.Errorf("the application requires a loopback bind behind its trusted proxy")
	}
	switch os.Getenv("APP_ALLOW_GUEST") {
	case "", "0":
	case "1":
		c.allowGuest = c.mode != "old-site"
	default:
		return c, fmt.Errorf("APP_ALLOW_GUEST must be 0 or 1")
	}
	switch c.mode {
	case "internal":
		if !c.allowGuest && (len(c.accessToken) < 24 || strings.Contains(strings.ToLower(c.accessToken), "replace")) {
			return c, fmt.Errorf("APP_ACCESS_TOKEN must be a random secret of at least 24 characters")
		}
	case "old-site":
		if e := c.oldSite.load(); e != nil {
			return c, e
		}
	default:
		return c, fmt.Errorf("APP_ENV must be internal or old-site")
	}
	n, e := envInt("APP_DAILY_TOKEN_BUDGET", 1_000_000)
	if e != nil {
		return c, e
	}
	c.dailyBudget = int64(n)
	c.maxOutput, e = envInt("APP_MAX_OUTPUT_TOKENS", 2048)
	if e != nil {
		return c, e
	}
	if c.maxOutput > 8192 {
		return c, fmt.Errorf("output limit exceeds 8192")
	}
	c.maxInput, e = envInt("APP_MAX_INPUT_BYTES", 64000)
	if e != nil {
		return c, e
	}
	if c.maxInput > 180000 {
		return c, fmt.Errorf("input limit exceeds 180000")
	}
	if !validID(c.model) || c.mode == "internal" && !validID(c.userID) {
		return c, fmt.Errorf("invalid model or developer ID")
	}
	return c, nil
}
func (s *appServer) modelReady() bool {
	return s.cfg.apiKey != "" && !strings.Contains(strings.ToLower(s.cfg.apiKey), "replace")
}
func fail(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": message}})
}
func decode(c *gin.Context, v any) error {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 262144)
	d := json.NewDecoder(c.Request.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	if e := d.Decode(&struct{}{}); e != io.EOF {
		return fmt.Errorf("trailing data")
	}
	return nil
}
func (s *appServer) session(c *gin.Context) {
	n, e := s.store.used(budgetDay(time.Now()))
	if e != nil {
		fail(c, 503, "STORAGE_FAILED", "用量存储暂不可用")
		return
	}
	user, name := c.GetString("userID"), c.GetString("userName")
	response := gin.H{"mode": s.mode(), "user": gin.H{"id": user, "name": name}, "modelReady": s.modelReady(), "model": s.cfg.model, "limits": gin.H{"maxToolCalls": 6, "timeoutSeconds": 120, "maxOutputTokens": s.cfg.maxOutput}, "budget": gin.H{"day": budgetDay(time.Now()), "limit": s.cfg.dailyBudget, "used": n}}
	if s.mode() == "old-site" {
		response["oldSite"] = gin.H{"status": c.GetString("materialAuthStatus")}
		if context, ok := c.Get("initialContext"); ok {
			response["initialContext"] = context
		}
	}
	c.JSON(200, response)
}
func newServer(cfg config, db *store) (*appServer, *gin.Engine) {
	s := &appServer{cfg: cfg, store: db, client: &http.Client{Timeout: cfg.timeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}, endpoint: "https://api.deepseek.com/chat/completions", slots: make(chan struct{}, 2)}
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// Only a reverse proxy on the application host may supply the client address.
	if e := r.SetTrustedProxies([]string{"127.0.0.0/8", "::1"}); e != nil {
		panic(e)
	}
	r.RemoteIPHeaders = []string{"X-Forwarded-For"}
	r.Use(gin.Recovery())
	r.Use(func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.Header("Cache-Control", "no-store")
		}
		if c.Request.Method != http.MethodGet {
			o := c.GetHeader("Origin")
			originRejected := o != "" && o != "http://"+c.Request.Host && o != "https://"+c.Request.Host
			if s.mode() == "old-site" {
				originRejected = o != cfg.oldSite.publicURL
			}
			if c.GetHeader("Sec-Fetch-Site") == "cross-site" || originRejected {
				fail(c, 403, "ORIGIN_REJECTED", "请求来源不被允许")
				return
			}
		}
		c.Next()
	})
	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "mode": s.mode(), "contractVersion": contractVersion, "modelReady": s.modelReady(), "oldSite": s.mode() == "old-site", "database": true})
	})
	r.GET("/api/auth/config", func(c *gin.Context) {
		c.JSON(200, gin.H{"mode": s.mode(), "oldSiteEntryUrl": cfg.oldSite.entryURL})
	})
	if s.mode() == "old-site" {
		r.GET("/api/auth/old-site/start", s.startOldSiteAuth)
		r.GET("/api/auth/old-site/callback", s.finishOldSiteAuth)
	} else {
		r.POST("/api/internal/session", func(c *gin.Context) {
			if s.mode() == "guest" {
				fail(c, 404, "NOT_IMPLEMENTED", "访客模式无需访问口令")
				return
			}
			s.loginMu.Lock()
			defer s.loginMu.Unlock()
			if time.Since(s.loginWindow) > time.Minute {
				s.loginFailures = 0
				s.loginWindow = time.Now()
			}
			if s.loginFailures >= 10 {
				fail(c, 429, "LOGIN_LIMIT", "尝试过多，请一分钟后再试")
				return
			}
			var v struct {
				AccessToken string `json:"accessToken"`
			}
			if decode(c, &v) != nil {
				fail(c, 400, "INVALID_REQUEST", "请求格式不正确")
				return
			}
			if subtle.ConstantTimeCompare([]byte(v.AccessToken), []byte(cfg.accessToken)) != 1 {
				s.loginFailures++
				fail(c, 401, "AUTH_REQUIRED", "内部访问口令不正确")
				return
			}
			token, e := randomToken()
			if e != nil {
				fail(c, 500, "SESSION_FAILED", "无法创建会话")
				return
			}
			_, e = db.db.Exec("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)", tokenHash(token), cfg.userID, time.Now().Add(8*time.Hour).Unix())
			if e != nil {
				fail(c, 503, "STORAGE_FAILED", "无法保存应用会话")
				return
			}
			s.setSessionCookie(c, token, 8*3600)
			c.Set("userID", cfg.userID)
			c.Set("userName", "内部开发者")
			s.session(c)
		})
	}
	api := r.Group("/api")
	api.Use(s.authenticate)
	api.GET("/session", s.session)
	api.POST("/logout", func(c *gin.Context) {
		if cfg.allowGuest {
			c.Status(204)
			return
		}
		token, _ := c.Cookie(cookieName)
		if e := s.removeSession(c.Request.Context(), tokenHash(token)); e != nil {
			fail(c, 503, "STORAGE_FAILED", "退出失败，请重试")
			return
		}
		s.setSessionCookie(c, "", -1)
		c.Status(204)
	})
	api.POST("/model", s.model)
	api.GET("/old-site/*path", s.materials)
	api.POST("/old-site/*path", s.materials)
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			fail(c, 404, "NOT_IMPLEMENTED", "此接口尚未实现")
			return
		}
		if c.Request.Method != http.MethodGet {
			c.Status(405)
			return
		}
		path := webpath.Clean("/" + c.Request.URL.Path)
		if path == "/" {
			path = "/index.html"
		}
		if path == "/index.html" {
			c.Header("Cache-Control", "no-cache")
		}
		full := filepath.Join(cfg.staticDir, filepath.FromSlash(strings.TrimPrefix(path, "/")))
		info, e := os.Stat(full)
		if e != nil || info.IsDir() {
			c.Status(404)
			return
		}
		c.File(full)
	})
	return s, r
}
func main() {
	cfg, e := loadConfig()
	if e != nil {
		log.Fatal(e)
	}
	if e = os.MkdirAll(filepath.Dir(cfg.dbPath), 0700); e != nil {
		log.Fatal(e)
	}
	db, e := openStore(cfg.dbPath)
	if e != nil {
		log.Fatal(e)
	}
	defer db.db.Close()
	_, router := newServer(cfg, db)
	server := &http.Server{Addr: cfg.bind, Handler: router, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		log.Printf("Cramameleon %s listening on %s", cfg.mode, cfg.bind)
		if e := server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			log.Fatal(e)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}
