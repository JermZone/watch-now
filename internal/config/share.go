package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// Automatic storage failures disable only sharing. Explicit key errors remain fatal.
var errShareStorage = errors.New("sharing unavailable: check the persistent sharing volume and its permissions")

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
		if dir := strings.TrimSpace(os.Getenv("NOW_SHARE_KEY_DIR")); dir != "" {
			key, err := storedShareKey(dir)
			if err != nil {
				return nil, errShareStorage
			}
			return key, nil
		}
		return nil, nil
	}
	key, err := hex.DecodeString(value)
	if err != nil || len(key) != 32 {
		return nil, failure
	}
	return key, nil
}

func storedShareKey(dir string) ([]byte, error) {
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errShareStorage
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, errShareStorage
	}
	defer root.Close()
	openedDir, err := root.Stat(".")
	if err != nil || !os.SameFile(info, openedDir) || openedDir.Mode().Perm()&0077 != 0 {
		return nil, errShareStorage
	}
	key, err := readStoredShareKey(root)
	if !errors.Is(err, os.ErrNotExist) {
		return key, err
	}
	key = make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		return nil, errShareStorage
	}
	// Write and sync privately before publishing. Link is atomic and cannot replace
	// another process's key; all concurrent starters then read the winning key.
	temp := ".share-key-" + rand.Text()
	file, err := root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, errShareStorage
	}
	defer root.Remove(temp)
	_, writeErr := file.WriteString(hex.EncodeToString(key) + "\n")
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return nil, errShareStorage
	}
	if err = root.Link(temp, "share-key"); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, errShareStorage
	}
	directory, err := root.Open(".")
	if err != nil {
		return nil, errShareStorage
	}
	syncErr = directory.Sync()
	directory.Close()
	if syncErr != nil {
		return nil, errShareStorage
	}
	return readStoredShareKey(root)
}

func readStoredShareKey(root *os.Root) ([]byte, error) {
	info, err := root.Lstat("share-key")
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 128 {
		return nil, errShareStorage
	}
	file, err := root.Open("share-key")
	if err != nil {
		return nil, errShareStorage
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errShareStorage
	}
	data, err := io.ReadAll(io.LimitReader(file, 129))
	if err != nil || len(data) > 128 {
		return nil, errShareStorage
	}
	key, err := hex.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(key) != 32 {
		return nil, errShareStorage
	}
	return key, nil
}
