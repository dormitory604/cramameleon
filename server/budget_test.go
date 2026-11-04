package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLifetimeBudgetIncludesHistoricalUsage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacy.Exec(`
 CREATE TABLE usage (request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, status TEXT NOT NULL);
 INSERT INTO usage VALUES
 ('old-completed', 'developer', '2026-11-03', ?, ?, ?, 0, 'completed'),
 ('old-interrupted', 'developer', '2026-11-04', 100, 100, NULL, NULL, 'unknown');`,
		totalTokenBudget-100, totalTokenBudget-200, totalTokenBudget-200)
	legacy.Close()
	if err != nil {
		t.Fatal(err)
	}
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.db.Close() })
	const day = "2026-11-05"
	if err := s.reserve("over", "guest-a", day, 101, 1000); !errors.Is(err, errTotalBudget) {
		t.Fatalf("historical usage did not constrain reservation: %v", err)
	}
	if err := s.reserve("at-limit", "guest-b", day, 100, 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.settle("at-limit", 10, 10, "completed"); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	if err := reopened.reserve("over-after-settlement", "guest-a", "2026-11-06", 81, 1000); !errors.Is(err, errTotalBudget) {
		t.Fatalf("lifetime charge was lost after reopening: %v", err)
	}
	if err := reopened.reserve("remaining", "guest-a", "2026-11-06", 80, 1000); err != nil {
		t.Fatalf("verified settlement did not release unused reservation: %v", err)
	}
}

func TestLifetimeBudgetConcurrentAcrossConnections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	first, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.db.Close()
	second, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.db.Close()
	if err := first.reserve("historical", "developer", "2026-11-04", totalTokenBudget-200, totalTokenBudget); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for i, s := range []*store{first, second} {
		id := fmt.Sprintf("guest-%d", i)
		go func() {
			<-start
			results <- s.reserve(id, id, "2026-11-05", 200, 1000)
		}()
	}
	close(start)
	a, b := <-results, <-results
	if !(a == nil && errors.Is(b, errTotalBudget) || b == nil && errors.Is(a, errTotalBudget)) {
		t.Fatalf("expected exactly one reservation and one lifetime quota rejection, got %v and %v", a, b)
	}
}

func TestLifetimeBudgetBlocksUpstream(t *testing.T) {
	s, srv, c := setup(t)
	login(t, srv, c)
	if err := s.store.reserve("historical", "developer", "2026-11-04", totalTokenBudget, totalTokenBudget); err != nil {
		t.Fatal(err)
	}
	mock(t, s, func(w http.ResponseWriter, r *http.Request) {
		t.Error("lifetime budget rejection contacted upstream")
		writeCompletion(w)
	})
	code, body := post(t, srv, c, request("lifetime-blocked"))
	if code != http.StatusTooManyRequests || !strings.Contains(body, `"code":"TOTAL_BUDGET_EXCEEDED"`) {
		t.Fatalf("got %d, %s", code, body)
	}
}

func TestIncompleteUsageKeepsLifetimeReservation(t *testing.T) {
	s, srv, c := setup(t)
	login(t, srv, c)
	mock(t, s, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"+
			"data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,\"total_tokens\":13}}\n\n")
	})
	_, body := post(t, srv, c, request("incomplete-usage"))
	if !strings.Contains(body, "MODEL_STREAM_INTERRUPTED") {
		t.Fatal(body)
	}
	used, err := s.store.used(budgetDay(time.Now()))
	if err != nil || used < 4096 {
		t.Fatalf("incomplete response refunded its reservation: used = %d, err = %v", used, err)
	}
	if err := s.store.reserve("over-after-interruption", "another-guest", "2026-11-04", totalTokenBudget-used+1, totalTokenBudget); !errors.Is(err, errTotalBudget) {
		t.Fatalf("lifetime counter lost incomplete reservation: %v", err)
	}
}
