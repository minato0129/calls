package main

import "testing"

func TestRoleFromEmail(t *testing.T) {
	for email, want := range map[string]string{
		"1234567@school.ac.jp":     "STUDENT",
		"123456@school.ac.jp":      "TEACHER", // 6桁
		"12345678@school.ac.jp":    "TEACHER", // 8桁
		"s1234567@school.ac.jp":    "TEACHER",
		"sato.hanako@school.ac.jp": "TEACHER",
	} {
		if got := roleFromEmail(email); got != want {
			t.Errorf("roleFromEmail(%q) = %s, want %s", email, got, want)
		}
	}
}

func TestEmailAllowed(t *testing.T) {
	open := &Config{}
	if !open.emailAllowed("anyone@example.com") {
		t.Error("ALLOWED_EMAIL_DOMAINS が空なら許可する")
	}
	c := &Config{AllowedDomains: []string{"school.ac.jp", "staff.school.ac.jp"}}
	for email, want := range map[string]bool{
		"1234567@school.ac.jp":       true,
		"sato@staff.school.ac.jp":    true,
		"1234567@other.ac.jp":        false,
		"x@evil-school.ac.jp":        false, // 末尾一致ではなく完全一致
		"x@school.ac.jp.example.com": false,
		"no-at-mark":                 false,
	} {
		if got := c.emailAllowed(email); got != want {
			t.Errorf("emailAllowed(%q) = %v, want %v", email, got, want)
		}
	}
}
