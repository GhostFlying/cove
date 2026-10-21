package node

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

// script feeds notifications to waitReauth, then blocks until ctx ends, as
// a watcher with nothing more to report does.
func script(ctx context.Context, msgs ...ipn.Notify) func() (ipn.Notify, error) {
	return func() (ipn.Notify, error) {
		if len(msgs) == 0 {
			<-ctx.Done()
			return ipn.Notify{}, ctx.Err()
		}
		m := msgs[0]
		msgs = msgs[1:]
		return m, nil
	}
}

func state(s ipn.State) ipn.Notify { return ipn.Notify{State: &s} }

func self(id string, k key.NodePublic) ipn.Notify {
	return ipn.Notify{SelfChange: &tailcfg.Node{StableID: tailcfg.StableNodeID(id), Key: k}}
}

func TestWaitReauthNeedsANewKeyAndRunning(t *testing.T) {
	oldKey, newKey := key.NewNode().Public(), key.NewNode().Public()
	errMsg := "invalid key"
	for _, c := range []struct {
		name string
		msgs []ipn.Notify
		// want is the completed stable ID, or "" if the wait must not
		// complete; wantLogin expects a login error.
		want      string
		wantLogin bool
	}{
		{name: "new key then running", msgs: []ipn.Notify{self("nClient", newKey), state(ipn.Running)}, want: "nClient"},
		{name: "running then new key", msgs: []ipn.Notify{state(ipn.Running), self("nClient", newKey)}, want: "nClient"},
		{name: "another identity is reported, not judged", msgs: []ipn.Notify{state(ipn.Running), self("nOther", newKey)}, want: "nOther"},
		// The old enrollment is, or becomes, runnable: no completion.
		{name: "old enrollment already running", msgs: []ipn.Notify{state(ipn.Running)}},
		{name: "old enrollment becomes running", msgs: []ipn.Notify{state(ipn.Starting), self("nClient", oldKey), state(ipn.Running)}},
		// Delayed: the new key arrived but the backend is not Running yet.
		{name: "new key, still starting", msgs: []ipn.Notify{state(ipn.Running), state(ipn.Starting), self("nClient", newKey)}},
		{name: "rejected", msgs: []ipn.Notify{state(ipn.Running), {ErrMessage: &errMsg}}, wantLogin: true},
		{name: "rejected first", msgs: []ipn.Notify{{ErrMessage: &errMsg}, self("nClient", newKey), state(ipn.Running)}, wantLogin: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			defer cancel()
			got, err := waitReauth(ctx, script(ctx, c.msgs...), oldKey)
			var le *LoginError
			switch {
			case c.wantLogin:
				if !errors.As(err, &le) {
					t.Fatalf("got %v, %v; want a login error", got, err)
				}
			case c.want == "":
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("completed without evidence: %v, %v", got, err)
				}
			default:
				if err != nil || string(got.StableID) != c.want {
					t.Fatalf("got %v, %v; want %s", got, err, c.want)
				}
			}
		})
	}
}

// A node whose key is unknown (it never stored one) completes on any new
// non-zero key.
func TestWaitReauthWithoutAStoredKey(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got, err := waitReauth(ctx, script(ctx, self("nClient", key.NodePublic{}), state(ipn.Running),
		self("nClient", key.NewNode().Public())), key.NodePublic{})
	if err != nil || got.StableID != "nClient" {
		t.Fatalf("got %v, %v", got, err)
	}
}

// bus models the IPN bus: a watcher receives only what is sent after it
// subscribed, so a reauth that subscribes late misses its own completion.
type bus struct {
	steps []string
	subs  []chan ipn.Notify
}

func (b *bus) send(msgs ...ipn.Notify) {
	for _, c := range b.subs {
		for _, m := range msgs {
			c <- m
		}
	}
}

// ops returns reauth steps on b; onStart and onLogin are sent when those
// steps run.
func (b *bus) ops(enrolled key.NodePublic, onStart, onLogin []ipn.Notify) reauthOps {
	return reauthOps{
		profileKey: func(context.Context) (ipn.StateKey, error) {
			b.steps = append(b.steps, "profile")
			return "profile-1", nil
		},
		storedKey: func(k ipn.StateKey) (key.NodePublic, error) {
			b.steps = append(b.steps, "storedKey")
			return enrolled, nil
		},
		watch: func(ctx context.Context) (func() (ipn.Notify, error), func(), error) {
			b.steps = append(b.steps, "watch")
			c := make(chan ipn.Notify, 16)
			b.subs = append(b.subs, c)
			next := func() (ipn.Notify, error) {
				select {
				case m := <-c:
					return m, nil
				case <-ctx.Done():
					return ipn.Notify{}, ctx.Err()
				}
			}
			return next, func() { b.steps = append(b.steps, "stop") }, nil
		},
		start: func(context.Context) error {
			b.steps = append(b.steps, "start")
			b.send(onStart...)
			return nil
		},
		login: func(context.Context) error {
			b.steps = append(b.steps, "login")
			b.send(onLogin...)
			return nil
		},
	}
}

// The watcher is subscribed before Start and the login, so a completion or
// an error the backend reports while either call runs is not missed.
func TestReauthSubscribesBeforeStartingTheLogin(t *testing.T) {
	oldKey, newKey := key.NewNode().Public(), key.NewNode().Public()
	errMsg := "invalid key"
	for _, c := range []struct {
		name             string
		onStart, onLogin []ipn.Notify
		wantLogin        bool
	}{
		{name: "completes during the login", onLogin: []ipn.Notify{self("nClient", newKey), state(ipn.Running)}},
		{name: "completes during start", onStart: []ipn.Notify{state(ipn.Running), self("nClient", newKey)}},
		{name: "rejected during start", onStart: []ipn.Notify{{ErrMessage: &errMsg}}, wantLogin: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			b := &bus{}
			got, err := runReauth(ctx, b.ops(oldKey, c.onStart, c.onLogin))
			var le *LoginError
			if c.wantLogin != errors.As(err, &le) || (!c.wantLogin && (err != nil || got != "nClient")) {
				t.Fatalf("got %q, %v", got, err)
			}
			want := []string{"profile", "storedKey", "watch", "start", "login", "stop"}
			if strings.Join(b.steps, ",") != strings.Join(want, ",") {
				t.Fatalf("steps %v, want %v", b.steps, want)
			}
		})
	}
}
