package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
)

type remoteEntry struct {
	data    []byte
	expires time.Time
}

type remoteCache struct {
	mu    sync.Mutex
	items map[string]remoteEntry
	size  int
	timer *time.Timer
}

func (cache *remoteCache) remove(key string) {
	cache.size -= len(cache.items[key].data)
	delete(cache.items, key)
}

func (cache *remoteCache) sweep() {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	for key, entry := range cache.items {
		if !time.Now().Before(entry.expires) {
			cache.remove(key)
		}
	}
	cache.timer = nil
	cache.schedule()
}

func (cache *remoteCache) schedule() {
	if len(cache.items) != 0 && cache.timer == nil {
		cache.timer = time.AfterFunc(time.Minute, cache.sweep)
	}
}

func (cache *remoteCache) get(key string) []byte {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	entry := cache.items[key]
	if !time.Now().Before(entry.expires) {
		cache.remove(key)
		return nil
	}
	return entry.data
}

func (cache *remoteCache) put(key string, data []byte, ttl time.Duration) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.items == nil {
		cache.items = make(map[string]remoteEntry)
	}
	cache.remove(key)
	for len(cache.items) >= 128 || cache.size+len(data) > 32<<20 {
		var oldest string
		for id, item := range cache.items {
			if oldest == "" || item.expires.Before(cache.items[oldest].expires) {
				oldest = id
			}
		}
		if oldest == "" {
			return
		}
		cache.remove(oldest)
	}
	cache.items[key] = remoteEntry{data, time.Now().Add(ttl)}
	cache.size += len(data)
	cache.schedule()
}

type remoteSource struct {
	DocumentID string `json:"documentId"`
	ChunkID    string `json:"chunkId"`
	Title      string `json:"title"`
	Text       string `json:"text"`
	Location   string `json:"location"`
	Page       int    `json:"page,omitempty"`
	Slide      int    `json:"slide,omitempty"`
	URL        string `json:"url"`
}

type remoteDocument struct {
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	Kind     string         `json:"kind"`
	Format   string         `json:"format"`
	Size     int64          `json:"size"`
	Warnings []string       `json:"warnings"`
	Chunks   []remoteSource `json:"chunks"`
}

func (doc *remoteDocument) attribute(path, issuer string) {
	parts := strings.Split(path, "/")
	kind := strings.TrimSuffix(parts[1], "s")
	doc.ID = "old-site:" + kind + ":" + parts[2]
	if kind == "package" {
		doc.ID += ":" + parts[4]
	}
	for i := range doc.Chunks {
		chunk := &doc.Chunks[i]
		chunk.DocumentID = doc.ID
		chunk.ChunkID = doc.ID + ":" + strconv.Itoa(i)
		chunk.URL = issuer + "/" + kind + "/" + parts[2]
	}
}

type remoteView struct {
	path, session, turn, call, query string
	start                            int
}

func parseRemoteView(c *gin.Context, path string) (string, remoteView, bool) {
	view := remoteView{start: 1}
	if strings.HasSuffix(path, "/parsed") {
		return strings.TrimSuffix(path, "/parsed") + "/content", view, true
	}
	view.turn, view.call, view.query = c.Query("turnId"), c.Query("callId"), strings.TrimSpace(c.Query("query"))
	var err error
	if start := c.Query("startChunk"); start != "" {
		view.start, err = strconv.Atoi(start)
	}
	if err != nil || view.start < 1 || view.start > 1000 || !validID(view.turn) || !validID(view.call) || len(view.query) > 500 {
		fail(c, 400, "INVALID_REQUEST", "资料读取参数不正确")
		return "", view, false
	}
	return strings.TrimSuffix(path, "/evidence") + "/content", view, true
}

type remoteEvidence struct {
	Warnings  []string       `json:"warnings,omitempty"`
	Untrusted bool           `json:"untrustedMaterial"`
	Kind      string         `json:"kind"`
	Chunks    []remoteSource `json:"chunks"`
	Total     int            `json:"totalChunks"`
	Next      *int           `json:"nextChunk"`
}

func evidenceKey(session, turn, call string) string {
	return "evidence:" + session + "|" + turn + "|" + call
}

func (s *appServer) sendRemoteView(c *gin.Context, view remoteView, raw []byte) {
	var doc remoteDocument
	if json.Unmarshal(raw, &doc) != nil || len(doc.Chunks) == 0 {
		fail(c, 502, "FILE_PARSE", "服务端未返回资料内容")
		return
	}
	if view.turn == "" {
		count := len(doc.Chunks)
		doc.Chunks = []remoteSource{}
		c.JSON(200, struct {
			remoteDocument
			Count int `json:"chunkCount"`
		}{doc, count})
		return
	}
	if view.start > len(doc.Chunks) {
		fail(c, 400, "INVALID_REQUEST", "文本块位置超出资料范围")
		return
	}
	result := remoteEvidence{Warnings: doc.Warnings, Untrusted: true, Kind: doc.Kind, Total: len(doc.Chunks), Chunks: []remoteSource{}}
	if view.query == "" {
		// Up to 3600 characters per call; the Agent makes at most three remote reads per turn.
		end := min(len(doc.Chunks), view.start+1)
		result.Chunks = doc.Chunks[view.start-1 : end]
		if end < len(doc.Chunks) {
			next := end + 1
			result.Next = &next
		}
	} else {
		words := strings.Fields(strings.ToLower(view.query))
		type hit struct{ index, score int }
		hits := []hit{}
		for i, chunk := range doc.Chunks {
			score := 0
			for _, word := range words {
				if strings.Contains(strings.ToLower(chunk.Text), word) {
					score++
				}
			}
			if score != 0 {
				hits = append(hits, hit{i, score})
			}
		}
		sort.SliceStable(hits, func(i, j int) bool { return hits[i].score > hits[j].score })
		for _, hit := range hits[:min(2, len(hits))] {
			result.Chunks = append(result.Chunks, doc.Chunks[hit.index])
		}
	}
	payload, _ := json.Marshal(result)
	s.remoteCache.put(evidenceKey(view.session, view.turn, view.call), payload, 4*time.Minute)
	result.Chunks = append([]remoteSource{}, result.Chunks...)
	for i := range result.Chunks {
		result.Chunks[i].Text = ""
	}
	c.JSON(http.StatusOK, result)
}

func (s *appServer) injectRemoteEvidence(session string, req *modelRequest) {
	if session == "" {
		return
	}
	allowed := map[string]bool{}
	var count int
	for i := range req.Messages {
		message := &req.Messages[i]
		for _, call := range message.ToolCalls {
			switch call.Function.Name {
			case "read_old_site", "read_context", "search_context":
				allowed[call.ID] = true
			}
		}
		if message.Role != "tool" || !allowed[message.ToolCallID] || message.Content != `{"remoteEvidence":true}` {
			continue
		}
		raw := s.remoteCache.get(evidenceKey(session, req.TurnID, message.ToolCallID))
		message.Content = `{"error":"服务端资料证据已过期或达到本轮上限，请重新读取。"}`
		if raw != nil && count < 3 {
			message.Content = string(raw)
			count++
		}
	}
}

func (s *appServer) verifyRemoteQuestion(c *gin.Context) {
	if c.GetHeader("X-Cram-User") != c.GetString("userID") || s.mode() != "old-site" {
		fail(c, 403, "ACCESS_DENIED", "请使用当前破壁计划账号")
		return
	}
	var request struct {
		TurnID string
		Calls  []string
		Refs   []struct{ DocumentID, ChunkID string }
		Parts  []string
	}
	if decode(c, &request) != nil || !validID(request.TurnID) || len(request.Calls) > 3 || len(request.Refs) > 6 || len(request.Parts) < 3 || len(request.Parts) > 7 {
		fail(c, 400, "INVALID_REQUEST", "题目核对参数不正确")
		return
	}
	normalize := func(text string) string {
		return strings.Map(func(r rune) rune {
			if unicode.IsSpace(r) {
				return -1
			}
			return r
		}, text)
	}
	for _, call := range request.Calls {
		if !validID(call) {
			continue
		}
		var evidence remoteEvidence
		raw := s.remoteCache.get(evidenceKey(c.GetString("sessionHash"), request.TurnID, call))
		if json.Unmarshal(raw, &evidence) != nil || evidence.Kind != "past_paper" {
			continue
		}
		for _, chunk := range evidence.Chunks {
			for _, ref := range request.Refs {
				if chunk.DocumentID != ref.DocumentID || chunk.ChunkID != ref.ChunkID {
					continue
				}
				// OCR is useful reading evidence, but not an exact original transcription.
				if strings.Contains(chunk.Location, "（含 OCR）") {
					continue
				}
				text := normalize(chunk.Text)
				match := true
				for _, part := range request.Parts {
					part = normalize(part)
					if part == "" || !strings.Contains(text, part) {
						match = false
						break
					}
				}
				if match {
					c.JSON(200, gin.H{"verified": true})
					return
				}
			}
		}
	}
	c.JSON(200, gin.H{"verified": false})
}
