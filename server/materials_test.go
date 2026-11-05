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
	for _, path := range []string{"/materials?url=https://evil.example", "/materials?token=secret", "/materials/1/preview", "/materials/1/content", "/packages/1/items/1/access"} {
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

func TestRemoteEvidenceRemainsServerSideAndIsTurnBound(t *testing.T) {
	f := oldAuth(t)
	f.callback(t, f.start(t, ""))
	_, session := f.session(t)
	user := session["user"].(map[string]any)["id"].(string)
	var hash string
	if err := f.s.store.db.QueryRow("SELECT token_hash FROM entry_sessions").Scan(&hash); err != nil {
		t.Fatal(err)
	}
	path := "/materials/1/content"
	doc := remoteDocument{ID: "old-site:material:1", Kind: "past_paper", Title: "高数", Warnings: []string{"图片中的题干和公式可能缺失"}, Chunks: []remoteSource{
		{DocumentID: "old-site:material:1", ChunkID: "old-site:material:1:0", Text: "private-question 选项甲 选项乙", Location: "第 1 页"},
	}}
	raw, _ := json.Marshal(doc)
	f.s.remoteCache.put("document:"+hash+":"+path, raw, time.Minute)
	call := func(method, path, body string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest(method, f.app.URL+path, strings.NewReader(body))
		req.Header.Set("Origin", f.s.cfg.oldSite.publicURL)
		req.Header.Set("X-Cram-User", user)
		response, err := f.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(data)
	}
	for _, endpoint := range []string{"/parsed", "/evidence?turnId=turn&callId=read"} {
		status, data := call("GET", "/api/old-site/materials/1"+endpoint, "")
		if status != 200 || strings.Contains(data, "private-question") {
			t.Fatalf("%d %s", status, data)
		}
	}
	var request modelRequest
	if err := json.Unmarshal([]byte(`{"turnId":"turn","messages":[{"role":"assistant","tool_calls":[{"id":"read","function":{"name":"read_old_site"}}]},{"role":"tool","tool_call_id":"read","content":"{\"remoteEvidence\":true}"}]}`), &request); err != nil {
		t.Fatal(err)
	}
	other := request
	other.Messages = append([]wireMessage(nil), request.Messages...)
	f.s.injectRemoteEvidence("different-session", &other)
	if strings.Contains(other.Messages[1].Content, "private-question") {
		t.Fatal("cross-session evidence leak")
	}
	f.s.injectRemoteEvidence(hash, &request)
	if !strings.Contains(request.Messages[1].Content, "图片中的题干和公式可能缺失") {
		t.Fatal("model did not receive extraction warnings")
	}
	if !strings.Contains(request.Messages[1].Content, "private-question") {
		t.Fatal("model did not receive evidence")
	}
	status, data := call("POST", "/api/old-site-verify", `{"turnId":"turn","calls":["missing-one","missing-two","read"],"refs":[{"documentId":"old-site:material:1","chunkId":"old-site:material:1:0"}],"parts":["private-question","选项甲","选项乙"]}`)
	if status != 200 || !strings.Contains(data, `"verified":true`) {
		t.Fatalf("%d %s", status, data)
	}
	doc.Chunks[0].Location = "第 1 页（含 OCR）"
	ocrRaw, _ := json.Marshal(remoteEvidence{Kind: "past_paper", Chunks: doc.Chunks})
	f.s.remoteCache.put(evidenceKey(hash, "turn", "read"), ocrRaw, time.Minute)
	status, data = call("POST", "/api/old-site-verify", `{"turnId":"turn","calls":["read"],"refs":[{"documentId":"old-site:material:1","chunkId":"old-site:material:1:0"}],"parts":["private-question","选项甲","选项乙"]}`)
	if status != 200 || !strings.Contains(data, `"verified":false`) {
		t.Fatalf("OCR was treated as verified original: %d %s", status, data)
	}
	key := evidenceKey(hash, "turn", "read")
	f.s.remoteCache.put(key, raw, -time.Second)
	if f.s.remoteCache.get(key) != nil {
		t.Fatal("expired data retained")
	}
}

func TestRemoteCacheExpiryRemovesWholeEntry(t *testing.T) {
	cache := &remoteCache{}
	cache.put("document", []byte(`{"title":"exam","chunks":[{"text":"body"}]}`), -time.Second)
	if cache.get("document") != nil || len(cache.items) != 0 || cache.size != 0 {
		t.Fatal("expired document left metadata or bytes behind")
	}
	if cache.timer != nil {
		cache.timer.Stop()
	}
	cache.put("document", []byte("refetched body"), time.Minute)
	if string(cache.get("document")) != "refetched body" {
		t.Fatal("document could not be refreshed")
	}
}

func TestInjectThreeRemoteCandidates(t *testing.T) {
	s := &appServer{}
	var req modelRequest
	req.TurnID = "turn"
	for _, id := range []string{"one", "two", "three", "four"} {
		var messages []wireMessage
		if err := json.Unmarshal([]byte(`[{"role":"assistant","tool_calls":[{"id":"`+id+`","function":{"name":"read_old_site"}}]},{"role":"tool","tool_call_id":"`+id+`","content":"{\"remoteEvidence\":true}"}]`), &messages); err != nil {
			t.Fatal(err)
		}
		req.Messages = append(req.Messages, messages...)
		s.remoteCache.put(evidenceKey("session", "turn", id), []byte(`{"candidate":"`+id+`"}`), time.Minute)
	}
	defer s.remoteCache.timer.Stop()
	s.injectRemoteEvidence("session", &req)
	if !strings.Contains(req.Messages[5].Content, `"three"`) {
		t.Fatal("third candidate evidence was lost")
	}
	if strings.Contains(req.Messages[7].Content, `"four"`) {
		t.Fatal("read limit was not enforced")
	}
}
