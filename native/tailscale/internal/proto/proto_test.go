package proto

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestReadFrameBounds(t *testing.T) {
	exact := strings.Repeat("a", 100)
	br := bufio.NewReaderSize(strings.NewReader(exact+"\nRAW BYTES"), 16)
	got, err := ReadFrame(br, 100)
	if err != nil || string(got) != exact {
		t.Fatalf("frame at the limit: %q %v", got, err)
	}
	// Bytes after the frame stay buffered for the raw stream.
	rest, _ := io.ReadAll(br)
	if string(rest) != "RAW BYTES" {
		t.Fatalf("remainder %q", rest)
	}

	br = bufio.NewReaderSize(strings.NewReader(exact+"a\n"), 16)
	if _, err := ReadFrame(br, 100); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("over the limit: %v", err)
	}
	if _, err := ReadFrame(bufio.NewReader(strings.NewReader(`{"op":`)), 100); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("truncated frame: %v", err)
	}
	if _, err := ReadFrame(bufio.NewReader(strings.NewReader("")), 100); !errors.Is(err, io.EOF) {
		t.Fatalf("empty input: %v", err)
	}
}

func TestReadRequestNeverQuotesTheFrame(t *testing.T) {
	_, err := ReadRequest(bufio.NewReader(strings.NewReader(`{"op":"login","authKey":"tskey-secret"` + "\n")))
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != CodeBadRequest || strings.Contains(pe.Message, "tskey") {
		t.Fatalf("got %v", err)
	}
}

func TestRequestFormattingHidesAuthKey(t *testing.T) {
	r := Request{ID: "1", Op: OpLogin, AuthKey: "tskey-secret"}
	s := fmt.Sprintf("%v %+v %#v %s", r, r, r, r)
	if strings.Contains(s, "tskey-secret") {
		t.Fatalf("formatted request leaks the key: %s", s)
	}
}
