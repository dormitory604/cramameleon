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
var errTotalBudget = errors.New("TOTAL_BUDGET_EXCEEDED")
var errDuplicate = errors.New("DUPLICATE_REQUEST")

const totalTokenBudget int64 = 100_000_000

type store struct{ db *sql.DB }

func openStore(path string) (*store, error) {
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	if _, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`); e == nil {
		e = initSchema(db)
	}
	if e != nil {
		db.Close()
		return nil, e
	}
	return &store{db}, nil
}

func initSchema(db *sql.DB) error {
	tx, e := db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	// Seed the lifetime counter once from all existing charges, including open reservations.
	// The triggers maintain it in the same transaction as changes to the ledger.
	_, e = tx.Exec(`
 CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS usage (request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, status TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS usage_day ON usage(day);
 CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(issuer,subject));
 CREATE TABLE IF NOT EXISTS auth_flows (state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier BLOB NOT NULL, context TEXT NOT NULL, expires INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS auth_flow_expiry ON auth_flows(expires);
 CREATE TABLE IF NOT EXISTS entry_sessions (token_hash TEXT PRIMARY KEY, credential BLOB NOT NULL, credential_expires INTEGER NOT NULL, context TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS usage_total (id INTEGER PRIMARY KEY CHECK (id = 1), charged INTEGER NOT NULL);
 INSERT INTO usage_total (id, charged)
 SELECT 1, COALESCE((SELECT SUM(charged) FROM usage), 0) WHERE NOT EXISTS (SELECT 1 FROM usage_total);
 CREATE TRIGGER IF NOT EXISTS usage_total_insert AFTER INSERT ON usage BEGIN
   UPDATE usage_total SET charged = charged + NEW.charged WHERE id = 1;
 END;
 CREATE TRIGGER IF NOT EXISTS usage_total_update AFTER UPDATE OF charged ON usage BEGIN
   UPDATE usage_total SET charged = charged - OLD.charged + NEW.charged WHERE id = 1;
 END;`)
	if e != nil {
		return e
	}
	return tx.Commit()
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
	// Start with a write statement so quota checks and inserts are serialized even
	// when multiple server processes share the SQLite database.
	result, e := tx.Exec(`INSERT INTO usage(request_id,user_id,day,reserved,charged,status)
 SELECT ?,?,?,?,?,'reserved'
 WHERE (SELECT charged FROM usage_total WHERE id=1) <= ?
 AND (SELECT COALESCE(SUM(charged),0) FROM usage WHERE day=?) <= ?
 ON CONFLICT(request_id) DO NOTHING`, id, user, day, n, n, totalTokenBudget-n, day, limit-n)
	if e != nil {
		return e
	}
	inserted, e := result.RowsAffected()
	if e != nil {
		return e
	}
	if inserted == 1 {
		return tx.Commit()
	}
	var exists int
	if e = tx.QueryRow("SELECT COUNT(*) FROM usage WHERE request_id=?", id).Scan(&exists); e != nil {
		return e
	}
	if exists > 0 {
		return errDuplicate
	}
	var used int64
	if e = tx.QueryRow("SELECT charged FROM usage_total WHERE id=1").Scan(&used); e != nil {
		return e
	}
	if n > totalTokenBudget-used {
		return errTotalBudget
	}
	return errBudget
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
