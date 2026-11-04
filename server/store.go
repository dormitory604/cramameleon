package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	_ "modernc.org/sqlite"
	"time"
)

var errBudget = errors.New("BUDGET_EXCEEDED")
var errDuplicate = errors.New("DUPLICATE_REQUEST")

type store struct{ db *sql.DB }

func openStore(path string) (*store, error) {
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	_, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS usage (request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, status TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS usage_day ON usage(day);`)
	if e != nil {
		db.Close()
		return nil, e
	}
	return &store{db}, nil
}
func tokenHash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func budgetDay(t time.Time) string {
	return t.In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
}
func (s *store) used(day string) (int64, error) {
	var n int64
	e := s.db.QueryRow("SELECT COALESCE(SUM(charged),0) FROM usage WHERE day=?", day).Scan(&n)
	return n, e
}
func (s *store) reserve(id, user, day string, n, limit int64) error {
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var exists int
	if e = tx.QueryRow("SELECT COUNT(*) FROM usage WHERE request_id=?", id).Scan(&exists); e != nil {
		return e
	}
	if exists > 0 {
		return errDuplicate
	}
	var used int64
	if e = tx.QueryRow("SELECT COALESCE(SUM(charged),0) FROM usage WHERE day=?", day).Scan(&used); e != nil {
		return e
	}
	if n > limit-used {
		return errBudget
	}
	_, e = tx.Exec("INSERT INTO usage(request_id,user_id,day,reserved,charged,status) VALUES(?,?,?,?,?,'reserved')", id, user, day, n, n)
	if e != nil {
		return e
	}
	return tx.Commit()
}

// Missing usage (disconnect, crash, upstream error) keeps the full reservation.
// Reservations survive restarts and are never automatically refunded.
func (s *store) settle(id string, input, output int64, status string) error {
	if input < 0 || output < 0 {
		_, e := s.db.Exec("UPDATE usage SET status=? WHERE request_id=?", status, id)
		return e
	}
	_, e := s.db.Exec("UPDATE usage SET charged=?,input_tokens=?,output_tokens=?,status=? WHERE request_id=?", input+output, input, output, status, id)
	return e
}
