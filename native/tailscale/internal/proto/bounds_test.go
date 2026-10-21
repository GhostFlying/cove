package proto

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

// worstText expands sixfold in JSON ('<' becomes <).
func worstText(n int) string { return strings.Repeat("<", n) }

func worstStreams() []StreamInfo {
	out := make([]StreamInfo, MaxStreams)
	for i := range out {
		out[i] = StreamInfo{
			ID:           "s18446744073709551615",
			StableNodeID: strings.Repeat("n", MaxNodeIDBytes),
			Port:         65535,
			Label:        worstText(MaxLabelBytes),
			StartedAt:    time.Now().UTC().Format(time.RFC3339),
		}
	}
	return out
}

func worstNode() *NodeInfo {
	n := NodeInfo{
		StableNodeID: strings.Repeat("n", 4*MaxNodeIDBytes),
		Name:         worstText(10 * MaxTextBytes),
		HostName:     worstText(10 * MaxTextBytes),
		LoginName:    worstText(10 * MaxTextBytes),
	}
	for range 3 * MaxIPs {
		n.TailscaleIPs = append(n.TailscaleIPs, strings.Repeat("f", 100))
	}
	n = n.Bounded()
	return &n
}

func encodedSize(t *testing.T, v any) int {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return len(b)
}

// Every response the daemons can produce fits in one frame, even with all
// variable fields at their bounds and worst-case JSON escaping.
func TestWorstCaseResponsesFitInOneFrame(t *testing.T) {
	id := strings.Repeat("<", MaxIDBytes)
	hello := Response{ID: id, OK: true, Result: Hello{
		Protocol: Version, Build: strings.Repeat("b", MaxBuildBytes), Mode: "dial", PID: math.MaxInt32,
		Streams: worstStreams(),
	}}
	warnings := []string{}
	for range 3 * MaxWarnings {
		warnings = append(warnings, worstText(10*MaxTextBytes))
	}
	confirmed := false
	status := Response{ID: id, OK: true, Result: Status{
		State: StateRunning, AuthURL: worstText(10 * MaxTextBytes), Self: worstNode(),
		Ports: make([]int, MaxPorts), Streams: worstStreams(), Warnings: warnings,
		RemoteLogoutConfirmed: &confirmed,
	}.Bounded()}
	active := Errorf(CodeActiveStreams, "%s", worstText(10*MaxTextBytes))
	active.Streams = append(worstStreams(), worstStreams()...)
	activeResp := Fail(Request{ID: id}, active)
	dial := Response{ID: id, OK: true, Result: DialResult{StreamID: "s18446744073709551615", Peer: *worstNode()}}
	header := ForwardHeader{Protocol: Version, Port: 65535, RemoteAddr: Truncate(worstText(10 * MaxTextBytes)),
		Peer: worstNode(), WhoIsError: Truncate(worstText(10 * MaxTextBytes))}

	for name, v := range map[string]any{
		"hello": hello, "status": status, "ACTIVE_STREAMS": activeResp, "dial": dial, "forward header": header,
	} {
		size := encodedSize(t, v)
		t.Logf("%s: %d bytes", name, size)
		if size > MaxFrameBytes {
			t.Errorf("worst-case %s is %d bytes, over the %d-byte frame limit", name, size, MaxFrameBytes)
		}
		var buf bytes.Buffer
		if err := WriteFrame(&buf, v); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestWriteFrameEnforcesTheOutboundLimit(t *testing.T) {
	var buf bytes.Buffer
	big := Response{ID: "7", OK: true, Result: strings.Repeat("x", MaxFrameBytes)}
	if err := WriteFrame(&buf, big); !errors.Is(err, ErrFrameTooLarge) || buf.Len() != 0 {
		t.Fatalf("oversized frame: err=%v wrote %d bytes", err, buf.Len())
	}
	if err := WriteResponse(&buf, big); err != nil {
		t.Fatal(err)
	}
	line, err := ReadFrame(bufio.NewReader(&buf), MaxFrameBytes)
	if err != nil {
		t.Fatal(err)
	}
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil || resp.OK || resp.ID != "7" || resp.Error.Code != CodeInternal {
		t.Fatalf("fallback response %s: %v", line, err)
	}
}

func TestReadRequestBoundsTheID(t *testing.T) {
	line := `{"id":"` + strings.Repeat("i", MaxIDBytes+1) + `","op":"status"}` + "\n"
	req, err := ReadRequest(bufio.NewReader(strings.NewReader(line)))
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != CodeBadRequest || len(req.ID) > MaxIDBytes {
		t.Fatalf("got %v, id %d bytes", err, len(req.ID))
	}
}

func TestTimeoutNeverOverflows(t *testing.T) {
	def, limit := 15*time.Second, time.Minute
	for _, c := range []struct {
		ms   int
		want time.Duration
	}{
		{0, def}, {-5, def}, {1, time.Millisecond}, {59999, 59999 * time.Millisecond},
		{60000, limit}, {math.MaxInt, limit}, {math.MaxInt64 / 1000, limit},
	} {
		if got := Timeout(c.ms, def, limit); got != c.want {
			t.Errorf("Timeout(%d) = %v, want %v", c.ms, got, c.want)
		}
	}
}

func TestIdentifierValidation(t *testing.T) {
	for _, ok := range []string{"1.2.3", "0.0.0-e2e+tsnet_test.1", "dev+0123abcd-dirty", strings.Repeat("a", MaxBuildBytes)} {
		if !ValidBuild(ok) {
			t.Errorf("ValidBuild(%q) = false", ok)
		}
	}
	for _, bad := range []string{"", "a b", "a\nb", "a=b", `a"b`, "a/b", strings.Repeat("a", MaxBuildBytes+1)} {
		if ValidBuild(bad) {
			t.Errorf("ValidBuild(%q) = true", bad)
		}
	}
	if !ValidNodeID("nXXXXCNTRL") || !ValidNodeID("TESTCTRL00000001") {
		t.Error("rejected a real stable node ID")
	}
	for _, bad := range []string{"", "a.b", "a:b", strings.Repeat("n", MaxNodeIDBytes+1)} {
		if ValidNodeID(bad) {
			t.Errorf("ValidNodeID(%q) = true", bad)
		}
	}
}

func TestTruncateKeepsUTF8(t *testing.T) {
	s := strings.Repeat("é", MaxTextBytes) // two bytes each
	got := Truncate(s)
	if len(got) > MaxTextBytes || !strings.HasPrefix(s, got) || len(got)%2 != 0 {
		t.Fatalf("truncated to %d bytes", len(got))
	}
}
