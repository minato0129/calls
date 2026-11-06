package main

import (
	"bytes"
	"crypto/ecdh"
	"encoding/base64"
	"fmt"
	"strings"
)

// VAPID 鍵の値を起動時に確かめる。
// 公開鍵が壊れていると、ブラウザで通知を登録するときに
// 「applicationServerKey must contain a valid P-256 public key」となって原因が分かりにくいため。
func validateVapidKeys(public, private string) error {
	if public == "" && private == "" {
		return nil // 未設定なら通知は無効(ログに出すだけ)
	}
	if public == "" || private == "" {
		return fmt.Errorf("VAPID_PUBLIC_KEY と VAPID_PRIVATE_KEY は両方設定してください")
	}
	pub, err := decodeKey(public)
	if err != nil || len(pub) != 65 || pub[0] != 0x04 {
		hint := ""
		if len(strings.TrimSpace(public)) == 43 {
			hint = "(43文字なので、秘密鍵を入れている可能性があります。公開鍵と秘密鍵が逆になっていないか確認してください)"
		}
		return fmt.Errorf("VAPID_PUBLIC_KEY が正しくありません。B で始まる87文字の値を1行で入れてください(今は%d文字)%s",
			len(strings.TrimSpace(public)), hint)
	}
	priv, err := decodeKey(private)
	if err != nil || len(priv) != 32 {
		hint := ""
		if len(strings.TrimSpace(private)) == 87 {
			hint = "(87文字なので、公開鍵を入れている可能性があります)"
		}
		return fmt.Errorf("VAPID_PRIVATE_KEY が正しくありません。43文字の値を1行で入れてください(今は%d文字)%s",
			len(strings.TrimSpace(private)), hint)
	}
	key, err := ecdh.P256().NewPrivateKey(priv)
	if err != nil {
		return fmt.Errorf("VAPID_PRIVATE_KEY が正しくありません: %v", err)
	}
	if !bytes.Equal(key.PublicKey().Bytes(), pub) {
		return fmt.Errorf("VAPID_PUBLIC_KEY と VAPID_PRIVATE_KEY が対になっていません。-genvapid で出力された2行をそのまま使ってください")
	}
	return nil
}

// base64url(パディングあり・なし)と、通常の base64 のどちらでも読む
func decodeKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{base64.RawURLEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.StdEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, fmt.Errorf("base64 として読めません")
}
