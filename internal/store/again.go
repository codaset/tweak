package store

import (
	"errors"
	"time"
)

// The second stage of "No lost tweaks" (docs/design.md): a printed tweak is
// confirmed only when Claude runs tweak work or tweak queue on it, which
// moves it on from delivered. Until then the bridge sends it again as an
// again: line once its wait is over, at most twice; after that only the
// developer's Send again does.

// MaxResends is how many again: lines the bridge sends by itself.
const MaxResends = 2

// ErrPickedUp refuses Send again on a tweak Claude has already confirmed.
// It is shown on the card as it is.
var ErrPickedUp = errors.New("Claude has picked this up already")

// Resend sends again every delivered tweak whose wait of after is over and
// which has had fewer than MaxResends again: lines, and returns them.
func (s *Store) Resend(after time.Duration) ([]Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT number FROM tweaks WHERE status = ? AND resends < ? AND wait_from IS NOT NULL AND wait_from <= ? ORDER BY number`,
		StatusDelivered, MaxResends, s.now()-after.Milliseconds())
	if err != nil {
		return nil, err
	}
	var numbers []int64
	for rows.Next() {
		var n int64
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return nil, err
		}
		numbers = append(numbers, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var out []Tweak
	for _, n := range numbers {
		tw, err := tx.again(n)
		if err != nil {
			return nil, err
		}
		out = append(out, tw)
	}
	return out, tx.commit()
}

// SendAgain is the card's Send again: one more again: line for a delivered
// tweak, unless one is already waiting to be printed.
func (s *Store) SendAgain(number int64) (Tweak, error) {
	tx, err := s.begin()
	if err != nil {
		return Tweak{}, err
	}
	defer tx.Rollback()
	tw, err := getTweak(tx, number)
	if err != nil {
		return Tweak{}, err
	}
	if tw.Status != StatusDelivered {
		return Tweak{}, ErrPickedUp
	}
	if tw.WaitFrom.IsZero() {
		return tw, nil
	}
	if tw, err = tx.again(number); err != nil {
		return Tweak{}, err
	}
	return tw, tx.commit()
}

// again counts one more resend, stops the wait until its line is printed,
// and logs tweak-again, which is the line.
func (t *eventTx) again(number int64) (Tweak, error) {
	if _, err := t.Exec(`UPDATE tweaks SET resends = resends + 1, wait_from = NULL, updated = ? WHERE number = ?`, t.s.now(), number); err != nil {
		return Tweak{}, err
	}
	tw, err := getTweak(t, number)
	if err != nil {
		return Tweak{}, err
	}
	return tw, t.logTweak(EventTweakAgain, tw)
}
