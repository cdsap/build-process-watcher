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

// remoteClient is the shared HTTP adapter for private /predict and timeline endpoints.
type remoteClient struct {
	url    string
	client *http.Client
}

func newRemoteClient(endpoint string, timeout time.Duration, authAudience string, httpClient *http.Client) (*remoteClient, error) {
	client, err := buildRemoteHTTPClient(timeout, authAudience, httpClient)
	if err != nil {
		return nil, err
	}
	return &remoteClient{url: endpoint, client: client}, nil
}

func buildRemoteHTTPClient(timeout time.Duration, authAudience string, override *http.Client) (*http.Client, error) {
	if override != nil {
		return override, nil
	}
	if audience := strings.TrimSpace(authAudience); audience != "" {
		idTokenClient, err := idtoken.NewClient(context.Background(), audience)
		if err != nil {
			return nil, fmt.Errorf("create identity token client: %w", err)
		}
		idTokenClient.Timeout = timeout
		return idTokenClient, nil
	}
	return &http.Client{Timeout: timeout}, nil
}

func buildPredictURL(providerURL string) (string, error) {
	providerURL = strings.TrimSpace(providerURL)
	if providerURL == "" {
		return "", fmt.Errorf("remote provider url is required")
	}
	return strings.TrimRight(providerURL, "/") + "/predict", nil
}

func buildTimelineURL(providerURL, path, defaultPath string) (string, error) {
	providerURL = strings.TrimSpace(providerURL)
	if providerURL == "" {
		return "", fmt.Errorf("remote forecast provider url is required")
	}
	base := stripPredictSuffix(strings.TrimRight(providerURL, "/"))
	return base + normalizeRemotePath(path, defaultPath), nil
}

// stripPredictSuffix removes a trailing /predict segment so timeline providers can
// reuse the same base URL configured for the /predict checkpoint endpoint.
func stripPredictSuffix(base string) string {
	if strings.HasSuffix(base, "/predict") {
		return strings.TrimSuffix(base, "/predict")
	}
	return base
}

func normalizeRemotePath(path, defaultPath string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		path = defaultPath
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return path
}

// postJSON POSTs a JSON payload and returns the response body, or a typed remoteError.
func (c *remoteClient) postJSON(ctx context.Context, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode remote request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create remote request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		kind := ErrRemoteFailed
		if isTimeoutError(err) {
			kind = ErrRemoteTimeout
		}
		return nil, newRemoteError(kind, fmt.Sprintf("remote request failed: %v", err), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, newRemoteError(classifyRemoteStatus(resp.StatusCode), fmt.Sprintf("remote provider returned status %d", resp.StatusCode), nil)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, newRemoteError(ErrRemoteFailed, fmt.Sprintf("read remote response: %v", err), err)
	}
	return data, nil
}
