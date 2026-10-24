package mobile

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode"
)

func TestControlFailureDoesNotReflectCredentialsOrRemoteBodies(t *testing.T) {
	secret := "tskey-auth-private-fixture"
	url := "https://owner:password@control.example/path?token=private-token#fragment"
	for _, tc := range []struct{ input, code string }{
		{"LOGIN_FAILED: netlinkrib: permission denied", "COVE_NATIVE_INTERFACES_UNAVAILABLE"},
		{"LOGIN_TIMEOUT: context deadline exceeded", "COVE_NATIVE_CONTROL_TIMEOUT"},
		{"LOGIN_UNCERTAIN: another identity", "COVE_NATIVE_IDENTITY_UNVERIFIED"},
		{"enrolled native node requires its original control URL", "COVE_NATIVE_CONTROL_SELECTION"},
		{"connect: connection refused", "COVE_NATIVE_CONTROL_UNREACHABLE"},
		{"unknown server body", "COVE_NATIVE_CONTROL_FAILED"},
		{strings.Repeat("untrusted body ", 1000), "COVE_NATIVE_CONTROL_FAILED"},
	} {
		raw := ControlFailureJSON(tc.input + "\n\x00" + secret + " " + url)
		var got struct{ Code, Reason string }
		if err := json.Unmarshal([]byte(raw), &got); err != nil {
			t.Fatal(err)
		}
		if got.Code != tc.code || len(got.Reason) > 192 || got.Reason == "" {
			t.Fatalf("unexpected diagnostic: %+v", got)
		}
		if strings.Contains(raw, secret) || strings.Contains(raw, "private-token") || strings.Contains(raw, "password") || strings.Contains(raw, "control.example") {
			t.Fatal("native diagnostic reflected a credential or URL")
		}
		for _, r := range got.Reason {
			if unicode.IsControl(r) {
				t.Fatal("native diagnostic reflected a control character")
			}
		}
	}
}
