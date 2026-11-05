package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
)

type parserOutput struct{ bytes.Buffer }

func (out *parserOutput) Write(data []byte) (int, error) {
	if out.Len()+len(data) > 16<<20 {
		return 0, errors.New("parsed output exceeds limit")
	}
	return out.Buffer.Write(data)
}

func (s *appServer) parseRemoteMaterial(c *gin.Context, response *http.Response, view remoteView) {
	_, attributes, err := mime.ParseMediaType(response.Header.Get("Content-Disposition"))
	name := attributes["filename"]
	if err != nil || name == "" || len(name) > 1024 {
		fail(c, 502, "FILE_UNAVAILABLE", "资料文件名无法确认")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
	defer cancel()
	parser := filepath.Join(s.cfg.staticDir, "..", "material-parser", "parse.mjs")
	cmd := exec.CommandContext(ctx, "node", "--max-old-space-size=160", parser, name)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
	cmd.Stdin = io.LimitReader(response.Body, remoteFileLimit+1)
	var output parserOutput
	cmd.Stdout = &output
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			fail(c, 504, "FILE_TIMEOUT", "服务端解析超时，请重试或选用较小的文件")
		} else {
			fail(c, 502, "FILE_PARSE", "服务端解析暂不可用，请稍后重试")
		}
		return
	}
	var result struct {
		Document json.RawMessage
		Error    *struct{ Code, Message string }
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		fail(c, 502, "FILE_PARSE", "服务端解析暂不可用，请稍后重试")
		return
	}
	if result.Error != nil {
		fail(c, 422, result.Error.Code, result.Error.Message)
		return
	}
	if len(result.Document) == 0 {
		fail(c, 502, "FILE_PARSE", "服务端未返回资料内容")
		return
	}
	var doc remoteDocument
	if json.Unmarshal(result.Document, &doc) != nil || len(doc.Chunks) == 0 {
		fail(c, 502, "FILE_PARSE", "服务端未返回资料内容")
		return
	}
	doc.Kind = "material"
	if response.Header.Get("X-Cram-Material-Category") == "past_exam" {
		doc.Kind = "past_paper"
	}
	doc.attribute(view.path, s.cfg.oldSite.issuer)
	encoded, _ := json.Marshal(doc)
	s.remoteCache.put("document:"+view.session+":"+view.path, encoded, 15*time.Minute)
	s.sendRemoteView(c, view, encoded)
}
