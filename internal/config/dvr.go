package config

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

// Load only a bounded regular file. Errors deliberately omit the filename,
// JSON input, usernames and keys because configuration errors are logged.
func loadDVRKeys(path string) (map[string]string, error) {
	if path == "" {
		return nil, nil
	}
	failure := func() (map[string]string, error) {
		return nil, fmt.Errorf("NOW_DVR_API_KEYS_FILE must be a readable JSON object mapping at most 256 usernames to valid API keys (maximum 256 KiB)")
	}
	stat, err := os.Stat(path)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 256<<10 {
		return failure()
	}
	file, err := os.Open(path)
	if err != nil {
		return failure()
	}
	defer file.Close()
	stat, err = file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 256<<10 {
		return failure()
	}
	decoder := json.NewDecoder(io.LimitReader(file, (256<<10)+1))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return failure()
	}
	keys := make(map[string]string)
	for decoder.More() {
		token, err = decoder.Token()
		if err != nil {
			return failure()
		}
		username, ok := token.(string)
		if !ok || username == "" || len(username) > 256 || strings.TrimSpace(username) != username || len(keys) >= 256 {
			return failure()
		}
		if _, duplicate := keys[username]; duplicate {
			return failure()
		}
		var key string
		if decoder.Decode(&key) != nil || !dispatcharr.ValidDVRKey(key) {
			return failure()
		}
		keys[username] = key
	}
	token, err = decoder.Token()
	if err != nil || token != json.Delim('}') {
		return failure()
	}
	if decoder.InputOffset() > 256<<10 {
		return failure()
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return failure()
	}
	return keys, nil
}

func loadDVRMasterKey() (string, error) {
	key := strings.TrimSpace(os.Getenv("NOW_DVR_MASTER_API_KEY"))
	path := strings.TrimSpace(os.Getenv("NOW_DVR_MASTER_API_KEY_FILE"))
	failure := fmt.Errorf("configure one valid DVR master API key using NOW_DVR_MASTER_API_KEY or NOW_DVR_MASTER_API_KEY_FILE (maximum 512 characters)")
	if path != "" {
		if key != "" {
			return "", failure
		}
		stat, err := os.Stat(path)
		if err != nil || !stat.Mode().IsRegular() || stat.Size() > 1024 {
			return "", failure
		}
		file, err := os.Open(path)
		if err != nil {
			return "", failure
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, 1025))
		if err != nil || len(data) > 1024 {
			return "", failure
		}
		key = strings.TrimSpace(string(data))
		if key == "" {
			return "", failure
		}
	}
	if key != "" && !dispatcharr.ValidDVRKey(key) {
		return "", failure
	}
	return key, nil
}
