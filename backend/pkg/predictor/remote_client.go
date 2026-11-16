package predictor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"google.golang.org/api/idtoken"
)

type remoteHTTPConfig struct {
	URL          string
	Timeout      time.Duration
	AuthAudience string
	HTTPClient   *http.Client
	DefaultPath  string
	Path         string
	// StripPredictSuffix removes a trailing /predict from the base URL before
	// appending DefaultPath (timeline providers share the reliability URL).
	StripPredictSuffix bool
}

type remoteClient struct {
	url    string
	client *http.Client
}

func newRemoteClient(config remoteHTTPConfig, defaultTimeout time.Duration) (*remoteClient, error) {
	providerURL := strings.TrimSpace(config.URL)
	if providerURL == "" {
		return nil, fmt.Errorf("remote provider url is required")
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	client := config.HTTPClient
	if client == nil {
		if audience := strings.TrimSpace(config.AuthAudience); audience != "" {
			idTokenClient, err := idtoken.NewClient(context.Background(), audience)
			if err != nil {
				return nil, fmt.Errorf("create identity token client: %w", err)
			}
			idTokenClient.Timeout = timeout
			client = idTokenClient
		} else {
			client = &http.Client{Timeout: timeout}
		}
	}

	base := strings.TrimRight(providerURL, "/")
	if config.StripPredictSuffix && strings.HasSuffix(base, "/predict") {
		base = strings.TrimSuffix(base, "/predict")
	}
	path := strings.TrimSpace(config.Path)
	if path == "" {
		path = config.DefaultPath
	}
	if path != "" && !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return &remoteClient{url: base + path, client: client}, nil
}

func (c *remoteClient) postJSON(ctx context.Context, payload any, decodeInto any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode remote request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create remote request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		kind := ErrRemoteFailed
		if isTimeoutError(err) {
			kind = ErrRemoteTimeout
		}
		return newRemoteError(kind, fmt.Sprintf("remote request failed: %v", err), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return newRemoteError(classifyRemoteStatus(resp.StatusCode), fmt.Sprintf("remote provider returned status %d", resp.StatusCode), nil)
	}
	if decodeInto == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(decodeInto); err != nil {
		return newRemoteError(ErrRemoteFailed, fmt.Sprintf("decode remote response: %v", err), err)
	}
	return nil
}

func normalizeTimelineBaseURL(raw string) string {
	base := strings.TrimRight(strings.TrimSpace(raw), "/")
	if strings.HasSuffix(base, "/predict") {
		base = strings.TrimSuffix(base, "/predict")
	}
	return base
}
