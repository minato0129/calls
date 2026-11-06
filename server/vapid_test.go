package main

import (
	"strings"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func TestValidateVapidKeys(t *testing.T) {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	priv2, pub2, _ := webpush.GenerateVAPIDKeys()
	cases := []struct {
		name, pub, priv, wantErr string
	}{
		{"未設定", "", "", ""},
		{"正しい", pub, priv, ""},
		{"前後の空白は許す", " " + pub + "\n", priv + " ", ""},
		{"片方だけ", pub, "", "両方"},
		{"逆に入れた", priv, pub, "秘密鍵を入れている可能性"},
		{"途中で切れた", pub[:60], priv, "今は60文字"},
		{"対になっていない", pub, priv2, "対になっていません"},
		{"別の組の公開鍵", pub2, priv, "対になっていません"},
	}
	for _, tc := range cases {
		err := validateVapidKeys(tc.pub, tc.priv)
		switch {
		case tc.wantErr == "" && err != nil:
			t.Errorf("%s: エラーにならないはずが %v", tc.name, err)
		case tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)):
			t.Errorf("%s: %q を含むエラーのはずが %v", tc.name, tc.wantErr, err)
		}
	}
}
