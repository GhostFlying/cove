package mobile

import (
	"encoding/json"
	"strings"
)

// ControlFailureJSON maps native control errors to a fixed diagnostic vocabulary.
// Go/control-plane messages may contain credentials, URLs or remote bodies; none
// of their text crosses this private app boundary. This is not a delivery receipt
// and never proves that a failed Login/Logout had no effect.
func ControlFailureJSON(message string) string {
	if len(message) > 4096 {
		message = message[:4096]
	}
	code, reason := "COVE_NATIVE_CONTROL_FAILED", "Native node control failed; its effect is unverified."
	switch {
	case strings.Contains(message, "netlinkrib"), strings.Contains(message, "net.Interfaces"), strings.Contains(message, "netmon"):
		code, reason = "COVE_NATIVE_INTERFACES_UNAVAILABLE", "Native network interfaces are unavailable; its effect is unverified."
	case strings.Contains(message, "original control URL"):
		code, reason = "COVE_NATIVE_CONTROL_SELECTION", "The enrolled node requires its original control selection."
	case strings.Contains(message, "LOGIN_UNCERTAIN"), strings.Contains(message, "IDENTITY_CHANGED"):
		code, reason = "COVE_NATIVE_IDENTITY_UNVERIFIED", "Node identity or enrollment is unverified; inspect status before another operation."
	case strings.Contains(message, "LOGIN_TIMEOUT"), strings.Contains(message, "context deadline exceeded"), strings.Contains(message, "i/o timeout"):
		code, reason = "COVE_NATIVE_CONTROL_TIMEOUT", "Native control timed out; enrollment may have changed."
	case strings.Contains(message, "no such host"):
		code, reason = "COVE_NATIVE_CONTROL_DNS", "Native control name resolution failed; its effect is unverified."
	case strings.Contains(message, "connection refused"):
		code, reason = "COVE_NATIVE_CONTROL_UNREACHABLE", "The native control connection was refused; its effect is unverified."
	case strings.Contains(message, "permission denied"), strings.Contains(message, "operation not permitted"):
		code, reason = "COVE_NATIVE_PLATFORM_DENIED", "The platform denied a native operation; its effect is unverified."
	case strings.Contains(message, "lock is held"):
		code, reason = "COVE_NATIVE_NODE_BUSY", "Another native owner is still draining this app node."
	case strings.Contains(message, "context canceled"), strings.Contains(message, "generation expired"), strings.Contains(message, "node is closed"):
		code, reason = "COVE_NATIVE_NODE_INACTIVE", "The native node is inactive; the operation's effect is unverified."
	}
	result, _ := json.Marshal(struct {
		Code   string `json:"code"`
		Reason string `json:"reason"`
	}{code, reason})
	return string(result)
}
