package config

import (
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
)

func loadShareKey() ([]byte, error) {
	value := strings.TrimSpace(os.Getenv("NOW_SHARE_KEY"))
	path := strings.TrimSpace(os.Getenv("NOW_SHARE_KEY_FILE"))
	failure := fmt.Errorf("configure one 32-byte hexadecimal share key using NOW_SHARE_KEY or NOW_SHARE_KEY_FILE")
	if path != "" {
		if value != "" {
			return nil, failure
		}
		stat, err := os.Stat(path)
		if err != nil || !stat.Mode().IsRegular() || stat.Size() > 128 {
			return nil, failure
		}
		file, err := os.Open(path)
		if err != nil {
			return nil, failure
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, 129))
		if err != nil || len(data) > 128 {
			return nil, failure
		}
		value = strings.TrimSpace(string(data))
		if value == "" {
			return nil, failure
		}
	}
	if value == "" {
		return nil, nil
	}
	key, err := hex.DecodeString(value)
	if err != nil || len(key) != 32 {
		return nil, failure
	}
	return key, nil
}
