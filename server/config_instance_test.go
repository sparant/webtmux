package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInstanceIDKeepsOnlyDigits(t *testing.T) {
	cases := map[string]string{"8090": "8090", "": "", "80';alert(1)//": "801"}
	for in, want := range cases {
		if got := instanceID(in); got != want {
			t.Errorf("instanceID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConfigServesInstanceID(t *testing.T) {
	s := &Server{options: &Options{Port: "8090"}}
	rec := httptest.NewRecorder()
	s.handleConfig(rec, httptest.NewRequest("GET", "/config.js", nil))
	if body := rec.Body.String(); !strings.Contains(body, "var webtmux_instance = '8090';") {
		t.Fatalf("config.js lacks webtmux_instance:\n%s", body)
	}
}
