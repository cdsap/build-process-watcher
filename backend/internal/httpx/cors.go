package httpx

import "net/http"

const (
	MethodsGET  = "GET, OPTIONS"
	MethodsPOST = "POST, OPTIONS"
	HeadersJSON = "Content-Type"
	HeadersAuth = "Content-Type, Authorization"
	// HeadersAdmin includes the cleanup admin secret used by POST /cleanup/stale.
	HeadersAdmin = "Content-Type, Authorization, X-Admin-Secret"
)

// SetCORSHeaders applies the shared CORS allow-* headers.
func SetCORSHeaders(w http.ResponseWriter, methods, allowHeaders string) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if methods != "" {
		w.Header().Set("Access-Control-Allow-Methods", methods)
	}
	if allowHeaders != "" {
		w.Header().Set("Access-Control-Allow-Headers", allowHeaders)
	}
}

// HandleCORSPreflight writes the shared CORS preflight response when method is OPTIONS.
// Returns true when the request was handled as a preflight.
func HandleCORSPreflight(w http.ResponseWriter, r *http.Request, methods, allowHeaders string) bool {
	if r.Method != http.MethodOptions {
		return false
	}
	SetCORSHeaders(w, methods, allowHeaders)
	w.WriteHeader(http.StatusOK)
	return true
}

// RequireMethod rejects non-matching methods with 405.
func RequireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	return false
}
